import 'dotenv/config';
import express, { Request, Response } from 'express';
import { initDb } from './db/database';
import { router } from './router';
import { startJobs, triggerSeoDigest, triggerDueTimeAlerts } from './schedulers/jobs';
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
