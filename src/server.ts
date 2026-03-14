import 'dotenv/config';
import express, { Request, Response } from 'express';
import { google } from 'googleapis';
import { initDb, upsertGoogleAccount, getEnabledGoogleAccounts, getDb } from './db/database';
import { router } from './router';
import { startJobs, triggerSeoDigest, triggerDueTimeAlerts, triggerGmailPoll, triggerCalendarReminders } from './schedulers/jobs';
import { sendWhatsApp } from './twilio';

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

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
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
  #header { background: #075e54; color: #fff; padding: 12px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  #header h1 { font-size: 17px; font-weight: 600; }
  #phone-wrap { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  #phone-wrap label { font-size: 12px; opacity: .8; }
  #phone-input { background: rgba(255,255,255,.15); border: none; border-radius: 6px; color: #fff; font-size: 13px; padding: 4px 8px; width: 200px; outline: none; }
  #phone-input::placeholder { color: rgba(255,255,255,.6); }
  #messages { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; }
  .bubble { max-width: 72%; padding: 8px 12px; border-radius: 8px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .bubble.user { background: #dcf8c6; align-self: flex-end; border-bottom-right-radius: 2px; }
  .bubble.bot { background: #fff; align-self: flex-start; border-bottom-left-radius: 2px; box-shadow: 0 1px 1px rgba(0,0,0,.08); }
  .bubble.typing { color: #888; font-style: italic; }
  #footer { background: #f0f0f0; padding: 8px 12px; display: flex; gap: 8px; flex-shrink: 0; }
  #msg-input { flex: 1; border: none; border-radius: 20px; padding: 10px 16px; font-size: 15px; outline: none; background: #fff; }
  #send-btn { background: #075e54; color: #fff; border: none; border-radius: 50%; width: 44px; height: 44px; font-size: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  #send-btn:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<div id="header">
  <h1>🤖 Bot Test Chat</h1>
  <div id="phone-wrap">
    <label>Telefone:</label>
    <input id="phone-input" type="text" value="whatsapp:+5500000000000" placeholder="whatsapp:+55...">
  </div>
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

function fmt(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\\*(.*?)\\*/g,'<b>$1</b>')
    .replace(/_(.*?)_/g,'<em>$1</em>')
    .replace(/~(.*?)~/g,'<s>$1</s>');
}

function addBubble(text, side, extra) {
  const d = document.createElement('div');
  d.className = 'bubble ' + side + (extra ? ' ' + extra : '');
  d.innerHTML = fmt(text);
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  return d;
}

async function send() {
  const msg = input.value.trim();
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

btn.addEventListener('click', send);
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }});
input.focus();
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
