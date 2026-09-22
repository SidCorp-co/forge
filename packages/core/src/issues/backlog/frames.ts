/** The wire vocabulary every backlog stream speaks (ISS-1173). Each frame names its kind in a
 *  `type` field inside the `data:` payload as well as on the SSE `event:` line, because
 *  `assistant/providers/sse.ts:frameData` keeps only `data:` lines and drops `event:`, `id:` and
 *  `retry:` — which is why `anthropic.ts` switches on a `type` in the JSON — and the forge CLI's
 *  reader does the same. An item's `seq` is transport order and never a rank, and its payload's
 *  fields sit at the top level so a reader never unwraps. */

export type BacklogStreamKind = 'ordering' | 'alike';

export type TruncationReason = 'items' | 'budget' | null;

export interface BacklogBound {
  items: number;
  budgetMs: number;
}

export interface MetaFrame {
  type: 'meta';
  kind: BacklogStreamKind;
  projectId: string;
  total: number;
  bound: BacklogBound;
  at: string;
}

export interface ItemFrame {
  type: 'item';
  seq: number;
  payload: unknown;
}

export interface ProgressFrame {
  type: 'progress';
  emitted: number;
  total: number;
  elapsedMs: number;
}

export interface EndFrame {
  type: 'end';
  complete: boolean;
  truncated: boolean;
  truncatedBy: TruncationReason;
  emitted: number;
  total: number;
}

export interface ErrorFrame {
  type: 'error';
  code: string;
  message: string;
  emitted: number;
}

export type BacklogFrame = MetaFrame | ItemFrame | ProgressFrame | EndFrame | ErrorFrame;

export const SHUTTING_DOWN = 'SERVER_SHUTTING_DOWN' as const;

export function frameData(frame: BacklogFrame): string {
  if (frame.type !== 'item') return JSON.stringify(frame);
  const { payload, ...rest } = frame;
  return JSON.stringify({ ...rest, ...(payload as Record<string, unknown>) });
}

export function sseMessage(frame: BacklogFrame): { event: string; data: string } {
  return { event: frame.type, data: frameData(frame) };
}
