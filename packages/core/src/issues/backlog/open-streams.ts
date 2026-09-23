/** Live backlog streams, so shutdown ends them: an open one holds SIGTERM until the 30s timeout
 *  forces exit 1, and cancelling before closing stops the producer rather than only the socket. */

import type { Cancellation } from './cancellation.js';

export interface OpenStream {
  cancellation: Cancellation;
  close: () => Promise<void>;
}

const open = new Set<OpenStream>();

export function registerBacklogStream(stream: OpenStream): () => void {
  open.add(stream);
  return () => open.delete(stream);
}

export function openBacklogStreamCount(): number {
  return open.size;
}

export async function closeBacklogStreams(): Promise<void> {
  const streams = [...open];
  open.clear();
  for (const stream of streams) stream.cancellation.cancel('shutdown');
  await Promise.all(streams.map((stream) => stream.close().catch(() => undefined)));
}
