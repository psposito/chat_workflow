import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { sendWhatsApp } from '../twilio';

export const webhookRouter = Router();

// POST /webhook — receives inbound WhatsApp messages from Twilio
webhookRouter.post('/', async (req: Request, res: Response) => {
  const from: string = req.body.From ?? '';
  const body: string = req.body.Body ?? '';

  if (!from || !body) {
    res.status(400).json({ error: 'Missing From or Body' });
    return;
  }

  const db = getDb();
  db.prepare(
    'INSERT INTO messages (from_num, body, direction) VALUES (?, ?, ?)',
  ).run(from, body, 'inbound');

  console.log(`[webhook] Received from ${from}: ${body}`);

  // Echo the message back as a simple demo
  const replyText = `You said: ${body}`;
  await sendWhatsApp(from.replace('whatsapp:', ''), replyText);

  db.prepare(
    'INSERT INTO messages (from_num, body, direction) VALUES (?, ?, ?)',
  ).run(from, replyText, 'outbound');

  res.status(200).send('<Response></Response>');
});
