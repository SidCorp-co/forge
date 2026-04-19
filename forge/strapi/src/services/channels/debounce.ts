import type { NormalizedMessage } from './message';

export class MessageDebouncer {
  private buffers = new Map<string, NormalizedMessage[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private flushDelayMs: number = 1500,
    private onFlush: (sessionKey: string, messages: NormalizedMessage[]) => void,
  ) {}

  push(sessionKey: string, msg: NormalizedMessage): void {
    const buf = this.buffers.get(sessionKey) ?? [];
    buf.push(msg);
    this.buffers.set(sessionKey, buf);

    const existing = this.timers.get(sessionKey);
    if (existing) clearTimeout(existing);

    this.timers.set(
      sessionKey,
      setTimeout(() => {
        const messages = this.buffers.get(sessionKey);
        this.buffers.delete(sessionKey);
        this.timers.delete(sessionKey);
        if (messages?.length) this.onFlush(sessionKey, messages);
      }, this.flushDelayMs),
    );
  }

  cancel(sessionKey: string): void {
    const timer = this.timers.get(sessionKey);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionKey);
    this.buffers.delete(sessionKey);
  }

  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.buffers.clear();
  }
}
