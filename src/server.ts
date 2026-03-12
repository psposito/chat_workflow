import 'dotenv/config';
import express, { Request, Response } from 'express';
import { initDb } from './db/database';
import { router } from './router';
import { startJobs, triggerSeoDigest } from './schedulers/jobs';

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

  // Respond with TwiML so Twilio delivers the reply immediately
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(
    `<Response><Message>${reply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Message></Response>`,
  );
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
