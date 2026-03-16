import 'dotenv/config';
import express, { Request, Response } from 'express';
import { google } from 'googleapis';
import { initDb, upsertGoogleAccount, getEnabledGoogleAccounts, getDb } from './db/database';
import { router } from './router';
import { startJobs, triggerSeoDigest, triggerDueTimeAlerts, triggerGmailPoll, triggerCalendarReminders } from './schedulers/jobs';
import { sendWhatsApp } from './twilio';
import { subscribeNotifications } from './chatNotifier';

const TWIML_MAX = 1500;

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function splitMessage(body: string): string[] {
  if (body.length <= TWIML_MAX) return [body];
  const chunks: string[] = [];
  const lines = body.split('\n');
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > TWIML_MAX) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get('/health', async (_req: Request, res: Response) => {
  const uptimeMs = process.uptime() * 1000;
  const uptimeHours = Math.round(uptimeMs / 3_600_000 * 10) / 10;
  const memMb = Math.round(process.memoryUsage().heapUsed / 1_048_576);

  // Google accounts status
  let googleStatus: { active: number; expired: number } = { active: 0, expired: 0 };
  try {
    const accounts = getEnabledGoogleAccounts();
    const now = new Date();
    googleStatus.active = accounts.filter(
      (a) => !a.token_expiry || new Date(a.token_expiry) > now,
    ).length;
    googleStatus.expired = accounts.length - googleStatus.active;
  } catch { /* non-fatal */ }

  // OpenAI check (lightweight)
  let openaiStatus = 'ok';
  if (!process.env.OPENAI_API_KEY) openaiStatus = 'not_configured';

  // Twilio check
  const twilioStatus =
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
      ? 'ok'
      : 'not_configured';

  // Last poll timestamps
  const { getPollState, getDb } = await import('./db/database');
  let lastGmailPoll: string | null = null;
  try {
    const accounts = getEnabledGoogleAccounts();
    for (const a of accounts) {
      const v = getPollState(`gmail_last_polled_${a.email}`);
      if (v && (!lastGmailPoll || parseInt(v) > parseInt(lastGmailPoll))) lastGmailPoll = v;
    }
  } catch { /* non-fatal */ }

  let pendingTasksCount = 0;
  try {
    pendingTasksCount = (getDb().prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='pending' AND completed_at IS NULL`).get() as { c: number }).c;
  } catch { /* non-fatal */ }

  res.json({
    status: 'healthy',
    uptime_hours: uptimeHours,
    memory_mb: memMb,
    database: 'ok',
    openai: openaiStatus,
    google_accounts: googleStatus,
    twilio: twilioStatus,
    last_gmail_poll: lastGmailPoll ? new Date(parseInt(lastGmailPoll)).toISOString() : null,
    pending_tasks_count: pendingTasksCount,
  });
});

// ---------------------------------------------------------------------------
// POST /webhook — Twilio WhatsApp inbound
// ---------------------------------------------------------------------------

app.post('/webhook', async (req: Request, res: Response) => {
  const from: string = req.body.From ?? '';
  const body: string = req.body.Body ?? '';

  if (!from || !body) {
    res.status(400).json({ error: 'Missing From or Body' });
    return;
  }

  console.log(`[webhook] ← ${from}: ${body}`);

  let reply = '';
  try {
    reply = await router(from, body);
  } catch (err) {
    console.error('[webhook] Router error:', err);
    reply = '⚠️ Ocorreu um erro ao processar sua mensagem. Tente novamente.';
  }

  console.log(`[webhook] → ${from}: ${reply.slice(0, 100)}${reply.length > 100 ? '…' : ''}`);

  const chunks = splitMessage(reply);

  if (chunks.length === 1) {
    // Single message — reply via TwiML (faster, no extra API call)
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(`<Response><Message>${escapeXml(chunks[0])}</Message></Response>`);
  } else {
    // Multiple chunks — send via REST API and return empty TwiML
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
    const to = from.replace('whatsapp:', '');
    for (const chunk of chunks) {
      await sendWhatsApp(to, chunk).catch((err) =>
        console.error('[webhook] Failed to send chunk:', err),
      );
    }
  }
});

// ---------------------------------------------------------------------------
// GET /auth/google — initiate OAuth2 web flow to link a Google account
// ---------------------------------------------------------------------------

app.get('/auth/google', (_req: Request, res: Response) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });
  res.redirect(url);
});

// ---------------------------------------------------------------------------
// GET /auth/google/callback — OAuth2 callback: exchange code, save tokens
// ---------------------------------------------------------------------------

app.get('/auth/google/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).send('Missing authorization code.');
    return;
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2Api.userinfo.get();

    const expiry = tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : new Date(Date.now() + 3_600_000).toISOString();

    upsertGoogleAccount(
      data.email!,
      data.name ?? data.email!,
      tokens.refresh_token ?? '',
      tokens.access_token ?? null,
      expiry,
      'calendar gmail userinfo',
    );

    console.log(`[auth] Google account linked: ${data.email}`);
    res.send(`<html><body style="font-family:sans-serif;padding:2rem">
      <h2>✅ Conta vinculada com sucesso!</h2>
      <p><strong>${data.email}</strong> foi conectada ao bot.</p>
      <p>Pode fechar esta aba.</p>
    </body></html>`);
  } catch (err) {
    console.error('[auth] Google callback error:', err);
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:2rem">
      <h2>❌ Erro ao vincular conta</h2>
      <p>${(err as Error).message}</p>
    </body></html>`);
  }
});

// ---------------------------------------------------------------------------
// POST /chat/message — test router without Twilio
// ---------------------------------------------------------------------------

app.post('/chat/message', async (req: Request, res: Response) => {
  const secret = process.env.CHAT_SECRET;
  if (secret && req.headers['x-chat-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const phone: string = req.body.phone || 'whatsapp:+5500000000000';
  const message: string = req.body.message ?? '';
  if (!message) { res.status(400).json({ error: 'Missing message' }); return; }

  try {
    const reply = await router(phone, message);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// GET /chat/events — SSE stream for push notifications to the web chat UI
// ---------------------------------------------------------------------------

app.get('/chat/events', (req: Request, res: Response) => {
  const secret = process.env.CHAT_SECRET;
  if (secret && req.headers['x-chat-secret'] !== secret && req.query.secret !== secret) {
    res.status(401).end();
    return;
  }

  const phone: string = (req.query.phone as string) || 'whatsapp:+5500000000000';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Keepalive ping every 25s to prevent proxy/Railway from closing idle connections
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  const unsubscribe = subscribeNotifications(phone, (text) => {
    res.write(`data: ${JSON.stringify({ text })}\n\n`);
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// GET /chat — chat test UI
// ---------------------------------------------------------------------------

const CHAT_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bot Test Chat</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #e5ddd5; height: 100dvh; display: flex; flex-direction: column; }
  #header { background: #075e54; color: #fff; padding: 10px 16px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  #header h1 { font-size: 16px; font-weight: 600; white-space: nowrap; }
  #status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; flex-shrink: 0; transition: background .3s; }
  #status-dot.offline { background: #f44336; }
  #phone-wrap { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  #phone-wrap label { font-size: 11px; opacity: .8; }
  #phone-input { background: rgba(255,255,255,.15); border: none; border-radius: 6px; color: #fff; font-size: 12px; padding: 3px 7px; width: 180px; outline: none; }
  #phone-input::placeholder { color: rgba(255,255,255,.5); }
  #notif-btn { background: rgba(255,255,255,.15); border: none; border-radius: 6px; color: #fff; font-size: 11px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  #quick-actions { background: #f5f5f5; border-bottom: 1px solid #ddd; padding: 6px 12px; display: flex; gap: 6px; flex-wrap: wrap; flex-shrink: 0; }
  .qa-btn { background: #fff; border: 1px solid #ddd; border-radius: 16px; padding: 4px 10px; font-size: 12px; cursor: pointer; white-space: nowrap; transition: background .15s; }
  .qa-btn:hover { background: #e8f5e9; border-color: #a5d6a7; }
  #messages { flex: 1; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 5px; }
  .bubble { max-width: 75%; padding: 7px 11px; border-radius: 8px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .bubble.user { background: #dcf8c6; align-self: flex-end; border-bottom-right-radius: 2px; }
  .bubble.bot { background: #fff; align-self: flex-start; border-bottom-left-radius: 2px; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
  .bubble.bot b { font-weight: 600; }
  .bubble.bot em { font-style: italic; color: #555; }
  .bubble.bot s { text-decoration: line-through; color: #999; }
  .bubble.bot a { color: #075e54; }
  .bubble.bot ul { padding-left: 18px; }
  .bubble.bot code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 13px; }
  .bubble.typing { color: #888; font-style: italic; }
  #footer { background: #f0f0f0; padding: 6px 10px; display: flex; gap: 7px; flex-shrink: 0; align-items: center; }
  #msg-input { flex: 1; border: none; border-radius: 20px; padding: 9px 15px; font-size: 15px; outline: none; background: #fff; }
  #send-btn { background: #075e54; color: #fff; border: none; border-radius: 50%; width: 42px; height: 42px; font-size: 19px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  #send-btn:disabled { opacity: .5; cursor: default; }
  #badge { position: fixed; top: 0; left: 0; }
</style>
</head>
<body>
<div id="header">
  <div id="status-dot" title="SSE desconectado"></div>
  <h1>🤖 Bot Test Chat</h1>
  <button id="notif-btn" onclick="requestNotifPermission()">🔔 Notificações</button>
  <div id="phone-wrap">
    <label>Telefone:</label>
    <input id="phone-input" type="text" value="whatsapp:+5500000000000" placeholder="whatsapp:+55...">
  </div>
</div>

<div id="quick-actions">
  <button class="qa-btn" onclick="quickSend('meu dia')">☀️ Meu dia</button>
  <button class="qa-btn" onclick="quickSend('minha agenda')">📅 Agenda</button>
  <button class="qa-btn" onclick="quickSend('minhas tarefas')">📋 Tarefas</button>
  <button class="qa-btn" onclick="quickSend('meus emails')">📧 E-mails</button>
  <button class="qa-btn" onclick="quickSend('seo')">📡 SEO</button>
  <button class="qa-btn" onclick="quickSend('ajuda')">❓ Ajuda</button>
</div>

<div id="messages"></div>

<div id="footer">
  <input id="msg-input" type="text" placeholder="Digite uma mensagem..." autocomplete="off">
  <button id="send-btn">➤</button>
</div>

<script>
const TOKEN = '__TOKEN__';
const SECRET = TOKEN ? new URLSearchParams(TOKEN.slice(1)).get('secret') : null;
const msgs = document.getElementById('messages');
const input = document.getElementById('msg-input');
const btn = document.getElementById('send-btn');
const phoneInput = document.getElementById('phone-input');
const statusDot = document.getElementById('status-dot');
let unreadCount = 0;

// ── Markdown-like formatting ─────────────────────────────────────────────────
function fmt(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<code>$1</code>')
    .replace(/\*(.*?)\*/g, '<b>$1</b>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/~(.*?)~/g, '<s>$1</s>')
    .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>')
    .replace(/^[ \t]*[•\-] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => '<ul>' + m + '</ul>');
}

function addBubble(text, side, extra) {
  const d = document.createElement('div');
  d.className = 'bubble ' + side + (extra ? ' ' + extra : '');
  d.innerHTML = fmt(text);
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  return d;
}

// ── Send message ─────────────────────────────────────────────────────────────
async function send(msg) {
  msg = (msg ?? input.value).trim();
  if (!msg) return;
  const phone = phoneInput.value.trim() || 'whatsapp:+5500000000000';
  input.value = '';
  btn.disabled = true;
  addBubble(msg, 'user');
  const typing = addBubble('digitando...', 'bot', 'typing');
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (SECRET) headers['x-chat-secret'] = SECRET;
    const r = await fetch('/chat/message', { method: 'POST', headers, body: JSON.stringify({ phone, message: msg }) });
    const data = await r.json();
    typing.remove();
    addBubble(data.reply || data.error || 'Sem resposta', data.error ? 'bot typing' : 'bot');
  } catch(e) {
    typing.remove();
    addBubble('Erro: ' + e.message, 'bot typing');
  }
  btn.disabled = false;
  input.focus();
}

function quickSend(msg) { input.value = msg; send(msg); }

btn.addEventListener('click', () => send());
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }});
input.focus();

// ── Browser notifications ────────────────────────────────────────────────────
function requestNotifPermission() {
  if (!('Notification' in window)) return alert('Este browser não suporta notificações.');
  Notification.requestPermission().then((p) => {
    document.getElementById('notif-btn').textContent = p === 'granted' ? '🔔 Ativado' : '🔕 Negado';
  });
}

function showBrowserNotif(text) {
  if (Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  new Notification('🤖 Bot Alerta', { body: text.slice(0, 120), icon: '' });
}

function updateBadge() {
  document.title = unreadCount > 0 ? '(' + unreadCount + ') WhatsApp Bot' : 'Bot Test Chat';
}

window.addEventListener('focus', () => { unreadCount = 0; updateBadge(); });

// ── SSE ──────────────────────────────────────────────────────────────────────
let evtSource = null;

function connectSSE() {
  if (evtSource) evtSource.close();
  const phone = phoneInput.value.trim() || 'whatsapp:+5500000000000';
  const qs = new URLSearchParams({ phone });
  if (SECRET) qs.set('secret', SECRET);
  evtSource = new EventSource('/chat/events?' + qs.toString());

  evtSource.onopen = () => {
    statusDot.className = '';
    statusDot.title = 'Conectado';
  };
  evtSource.onmessage = (e) => {
    try {
      const { text } = JSON.parse(e.data);
      addBubble('🔔 ' + text, 'bot');
      if (!document.hasFocus()) {
        unreadCount++;
        updateBadge();
        showBrowserNotif(text);
      }
    } catch (_) {}
  };
  evtSource.onerror = () => {
    statusDot.className = 'offline';
    statusDot.title = 'Desconectado — reconectando...';
  };
}

connectSSE();
phoneInput.addEventListener('change', connectSSE);
</script>
</body>
</html>`;

app.get('/chat', (req: Request, res: Response) => {
  const secret = process.env.CHAT_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(401).send('Unauthorized — add ?secret=... to the URL');
    return;
  }
  const token = secret ? `?secret=${encodeURIComponent(secret)}` : '';
  res.setHeader('Content-Type', 'text/html');
  res.send(CHAT_HTML.replace('__TOKEN__', token));
});

// ---------------------------------------------------------------------------
// GET /debug/db — diagnose DB state
// ---------------------------------------------------------------------------

app.get('/debug/db', (_req: Request, res: Response) => {
  const dbPath = process.env.DB_PATH || 'default (data/bot.db)';
  const accounts = getEnabledGoogleAccounts();
  const allAccounts = getDb().prepare('SELECT id, email, enabled, scopes, updated_at FROM google_accounts').all();
  res.json({ dbPath, enabledAccounts: accounts.map(a => ({ id: a.id, email: a.email, scopes: a.scopes })), allAccounts });
});

// ---------------------------------------------------------------------------
// POST /trigger-seo — manually fire SEO digest (for testing)
// ---------------------------------------------------------------------------

app.post('/trigger-seo', async (_req: Request, res: Response) => {
  try {
    await triggerSeoDigest();
    res.json({ status: 'ok', message: 'SEO digest sent' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// POST /trigger-alerts — manually fire due-time alerts (for testing)
// ---------------------------------------------------------------------------

app.post('/trigger-alerts', async (_req: Request, res: Response) => {
  try {
    await triggerDueTimeAlerts();
    res.json({ status: 'ok', message: 'Due-time alerts checked and sent' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// POST /trigger-gmail — manually fire Gmail poll (for testing)
// ---------------------------------------------------------------------------

app.post('/trigger-gmail', async (_req: Request, res: Response) => {
  try {
    const result = await triggerGmailPoll();
    res.json({ status: result.errors.length === 0 ? 'ok' : 'partial', ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// POST /trigger-calendar — manually fire calendar reminder check (for testing)
// ---------------------------------------------------------------------------

app.post('/trigger-calendar', async (_req: Request, res: Response) => {
  try {
    await triggerCalendarReminders();
    res.json({ status: 'ok', message: 'Calendar reminders checked and sent' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// POST /test-send — send a test message directly to NOTIFY_PHONES
// ---------------------------------------------------------------------------

app.post('/test-send', async (_req: Request, res: Response) => {
  const { sendWhatsApp } = await import('./twilio');
  const phones = (process.env.NOTIFY_PHONES ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const results: Record<string, string> = {};
  for (const phone of phones) {
    try {
      await sendWhatsApp(phone.replace('whatsapp:', ''), '✅ Teste de envio direto — bot funcionando!');
      results[phone] = 'ok';
    } catch (err) {
      results[phone] = (err as Error).message;
    }
  }
  res.json(results);
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export function startServer(port: number | string = process.env.PORT ?? 3000): void {
  initDb();
  startJobs();
  app.listen(port, () => {
    console.log(`[server] Listening on port ${port}`);
  });
}

export default app;
