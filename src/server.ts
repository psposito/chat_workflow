import 'dotenv/config';
import express, { Request, Response } from 'express';
import { google } from 'googleapis';
import { initDb, upsertGoogleAccount } from './db/database';
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
      'calendar userinfo',
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
    await triggerGmailPoll();
    res.json({ status: 'ok', message: 'Gmail poll completed' });
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
