import { Router, Request, Response } from 'express';
import { sendWhatsApp } from '../twilio';
import { router } from '../router';

export const webhookRouter = Router();

// POST /webhook — receives inbound WhatsApp messages from Twilio
webhookRouter.post('/', async (req: Request, res: Response) => {
  const from: string = req.body.From ?? '';
  const body: string = req.body.Body ?? '';

  if (!from || !body) {
    res.status(400).json({ error: 'Missing From or Body' });
    return;
  }

  console.log(`[webhook] Received from ${from}: ${body}`);

  try {
    const reply = await router(from, body);
    await sendWhatsApp(from.replace('whatsapp:', ''), reply);
    console.log(`[webhook] Replied to ${from}: ${reply.slice(0, 80)}...`);
  } catch (err) {
    console.error('[webhook] Error processing message:', err);
  }

  res.status(200).send('<Response></Response>');
});
