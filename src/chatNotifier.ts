import { EventEmitter } from 'events';

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

/** Strip the "whatsapp:" prefix so all comparisons use raw phone numbers. */
function normalize(phone: string): string {
  return phone.replace('whatsapp:', '');
}

// Track which phones have an active SSE connection right now
const connectedPhones = new Set<string>();

export function emitNotification(phone: string, text: string): void {
  emitter.emit('msg', normalize(phone), text);
}

/** Returns an unsubscribe function. */
export function subscribeNotifications(
  phone: string,
  handler: (text: string) => void,
): () => void {
  const norm = normalize(phone);
  connectedPhones.add(norm);

  const wrapper = (p: string, t: string) => {
    if (p === norm) handler(t);
  };
  emitter.on('msg', wrapper);

  return () => {
    emitter.off('msg', wrapper);
    connectedPhones.delete(norm);
  };
}

/** Phones currently connected via SSE (already normalized, no "whatsapp:" prefix). */
export function getConnectedPhones(): string[] {
  return Array.from(connectedPhones);
}
