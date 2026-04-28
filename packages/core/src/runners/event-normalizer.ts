import type { JobEventKind } from '../db/schema.js';

export interface AntigravityWireEvent {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

export interface NormalizedJobEvent {
  kind: JobEventKind;
  data: Record<string, unknown>;
}

/**
 * Map an Antigravity SSE event onto our internal `jobEvents.kind` vocabulary.
 * Unknown events return an empty list — the caller should not persist them.
 * The original wire event is preserved under `data._raw` for forensics.
 *
 * The wire event names are based on Antigravity's documented SSE schema; a
 * follow-up may add more types as the service evolves. Keep this function pure
 * (no I/O) so it can be unit-tested with a table of cases.
 */
export function normalizeAntigravityEvent(event: AntigravityWireEvent): NormalizedJobEvent[] {
  const raw = event.data ?? {};
  // Compact `_raw`: keep only the wire envelope (type+timestamp), not a full
  // copy of `data` — for `progress`/`result`/`stderr` we already spread `raw`
  // so duplicating the same payload under `_raw.data` would triple storage.
  const envelope: Record<string, unknown> = { type: event.type };
  if (event.timestamp !== undefined) envelope['timestamp'] = event.timestamp;
  const withRaw = (kind: JobEventKind, data: Record<string, unknown>): NormalizedJobEvent => ({
    kind,
    data: { ...data, _raw: envelope },
  });

  switch (event.type) {
    case 'tool_started':
    case 'tool_call':
      return [
        withRaw('tool_call', {
          tool: raw['tool'] ?? raw['name'],
          args: raw['args'] ?? raw['arguments'],
        }),
      ];
    case 'tool_finished':
    case 'tool_result':
      return [
        withRaw('tool_result', {
          tool: raw['tool'] ?? raw['name'],
          result: raw['result'] ?? raw['output'],
        }),
      ];
    case 'assistant_chunk':
    case 'text': {
      const text = raw['text'] ?? raw['content'];
      if (typeof text !== 'string') return [];
      return [withRaw('stdout', { text })];
    }
    case 'usage_update':
    case 'progress':
      return [withRaw('progress', { ...raw })];
    case 'error':
      return [
        withRaw('stderr', {
          message: raw['message'] ?? 'antigravity error',
          ...raw,
        }),
      ];
    case 'done':
    case 'result':
      return [withRaw('result', { ...raw })];
    default:
      return [];
  }
}
