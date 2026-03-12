import 'dotenv/config';
import express, { Request, Response } from 'express';
import { initDb } from './db/database';
import { router } from './router';
import { startJobs } from './schedulers/jobs';

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
