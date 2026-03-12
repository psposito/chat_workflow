import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;
const from = process.env.TWILIO_WHATSAPP_FROM!;

const client = twilio(accountSid, authToken);

const MAX_LENGTH = 1500;

function splitMessage(body: string): string[] {
  if (body.length <= MAX_LENGTH) return [body];

  const chunks: string[] = [];
  const lines = body.split('\n');
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_LENGTH) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export async function sendWhatsApp(to: string, body: string): Promise<void> {
  const chunks = splitMessage(body);
  for (const chunk of chunks) {
    await client.messages.create({
      from,
      to: `whatsapp:${to}`,
      body: chunk,
    });
  }
}
