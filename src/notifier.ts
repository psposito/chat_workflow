import { emitNotification } from './chatNotifier';

/** Strip "whatsapp:" prefix so sendWhatsApp gets a clean number. */
function normalizePhone(phone: string): string {
  return phone.replace('whatsapp:', '');
}

/**
 * Send a notification to a phone number via all available channels:
 *  1. Web-chat SSE (always — for the /chat test UI)
 *  2. Twilio WhatsApp (only when credentials are set)
 *
 * Phone can be passed with or without "whatsapp:" prefix — normalized internally.
 */
export async function notify(phone: string, text: string): Promise<void> {
  const clean = normalizePhone(phone);

  // Always push to any connected SSE clients (web chat)
  emitNotification(clean, text);

  // Send via Twilio only if credentials are configured
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM
  ) {
    try {
      const { sendWhatsApp } = await import('./twilio');
      await sendWhatsApp(clean, text);
    } catch (err) {
      console.error('[notifier] Twilio send failed:', (err as Error).message);
    }
  }
}
