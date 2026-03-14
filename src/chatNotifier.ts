import { EventEmitter } from 'events';

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function emitNotification(phone: string, text: string): void {
  emitter.emit('msg', phone, text);
}

/** Returns an unsubscribe function. */
export function subscribeNotifications(
  phone: string,
  handler: (text: string) => void,
): () => void {
  const wrapper = (p: string, t: string) => {
    if (p === phone) handler(t);
  };
  emitter.on('msg', wrapper);
  return () => emitter.off('msg', wrapper);
}
