import { emitNotification } from './chatNotifier';

/**
 * Send a notification to a phone number via all available channels:
 *  1. Web-chat SSE (always — for the /chat test UI)
 *  2. Twilio WhatsApp (only when TWILIO_WHATSAPP_FROM is set)
 */
export async function notify(phone: string, text: string): Promise<void> {
  // Always push to any connected SSE clients (web chat)
  emitNotification(phone, text);

  // Send via Twilio only if credentials are configured
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM
  ) {
    try {
      const { sendWhatsApp } = await import('./twilio');
      await sendWhatsApp(phone, text);
    } catch (err) {
      console.error('[notifier] Twilio send failed:', (err as Error).message);
    }
  }
}
