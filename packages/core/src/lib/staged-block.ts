// A visual block checked and waiting on the reply it belongs to (REQ-32 criteria 5 and 6). A block a
// chat turn or an Agent-mode turn draws is not written into the room when it is drawn: it waits here,
// outside `conversation_messages`, so no reader of the room can see it, and is posted just above the
// reply once that reply passes the reply check. A held reply keeps its blocks under the held-reply
// disclosure; a reply that is rewritten or never sent drops the blocks it does not keep, by name.

import type { ContentBlock } from './agent-stream-parser.js';

export interface StagedBlock {
  /** The block's plain-text fallback, the row's content once it is posted. */
  readonly text: string;
  /** The `visual` content block, with the run its figures came from. */
  readonly block: ContentBlock;
  readonly kind: string;
  readonly runId: string | null;
  readonly projectId: string;
  /** Who drew it: the row is the project's handle's, or theirs where the room has no handle. */
  readonly askerUserId: string;
}

/** Where a turn holds the blocks it draws until its reply is judged. */
export interface BlockStage {
  /** What the person asked: a number they typed may stand in a block's title or label. */
  readonly question: string;
  hold(block: StagedBlock): Promise<void>;
}

/** A block a turn drew and nobody will see, named in the turn's record with why. */
export interface DroppedBlock {
  readonly kind: string;
  readonly runId: string | null;
  readonly why: string;
}

const str = (v: unknown): v is string => typeof v === 'string';

/** The staged blocks a stored document holds; an entry of any other shape is not one. */
export function stagedBlocksOf(raw: unknown): StagedBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (b): b is StagedBlock =>
      b !== null &&
      typeof b === 'object' &&
      str(b.text) &&
      str(b.kind) &&
      str(b.projectId) &&
      str(b.askerUserId) &&
      (b.runId === null || str(b.runId)) &&
      b.block !== null &&
      typeof b.block === 'object' &&
      (b.block as { type?: unknown }).type === 'visual',
  );
}

/** The record of each block in `blocks`, dropped for `why`. */
export const droppedAs = (blocks: readonly StagedBlock[], why: string): DroppedBlock[] =>
  blocks.map((b) => ({ kind: b.kind, runId: b.runId, why }));
