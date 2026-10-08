// The blocks one chat turn draws, held until its reply is judged (REQ-32 criteria 5 and 6). A block
// belongs to the answer whose attempt drew it: the reply that goes out releases its own answer's
// blocks, posted just above it, and every other block is dropped and named in the turn's record.
// A rewrite keeps a block by drawing it again; the corrective instruction says so.

import type { BlockStage, DroppedBlock, StagedBlock } from '../lib/staged-block.js';
import { droppedAs } from '../lib/staged-block.js';

const REFUSED_ANSWER =
  'it was drawn for an answer the reply check refused, and the rewrite that went out did not draw it again';
const NO_OWN_WORDS =
  'the turn sent none of its own words (a code-authored line, or nothing), so nothing it drew is shown';
const NOT_DELIVERED = 'the reply it was held with was not delivered';

export class TurnBlockStage {
  readonly #held: { attempt: number; block: StagedBlock }[] = [];
  #attempt = 0;
  /** The attempt whose words went out, once the screen settled; null where none of them did. */
  #answeredBy: number | null | undefined;
  #released = new Set<StagedBlock>();

  constructor() {
    this.stage = {
      hold: async (block) => {
        this.#held.push({ attempt: this.#attempt, block });
      },
    };
  }

  /** What the turn's tools hold a block on. */
  readonly stage: BlockStage;

  /** The blocks the given attempt drew, in the order it drew them. */
  of(attempt: number): StagedBlock[] {
    return this.#held.filter((h) => h.attempt === attempt).map((h) => h.block);
  }

  /** The attempt now drawing: the first is 0, and each rewrite the next. */
  get attempt(): number {
    return this.#attempt;
  }

  /**
   * Begin a rewrite, and say what it must know about the blocks the refused answer drew: they are
   * not shown unless it draws them again. Null where that answer drew none.
   */
  rewrite(): string | null {
    const drawn = this.of(this.#attempt);
    this.#attempt += 1;
    if (drawn.length === 0) return null;
    return `The ${drawn.length} block(s) you drew for that answer (${drawn.map((b) => b.kind).join(', ')}) are held with it and will not be shown: call forge_show again for each block your rewrite keeps, and a block you do not draw again is dropped.`;
  }

  /** Record whose words went out: an attempt, or null for a code-authored line or no reply. */
  settle(answeredBy: number | null): void {
    this.#answeredBy = answeredBy;
  }

  /** The blocks the reply that goes out releases: its own answer's. */
  kept(): StagedBlock[] {
    return this.#answeredBy === undefined || this.#answeredBy === null
      ? []
      : this.of(this.#answeredBy);
  }

  /** The blocks were posted with their reply. */
  released(blocks: readonly StagedBlock[]): void {
    for (const b of blocks) this.#released.add(b);
  }

  /** Every block the turn drew that nobody will see, with why. */
  dropped(): DroppedBlock[] {
    const unseen = this.#held.filter((h) => !this.#released.has(h.block));
    const by = this.#answeredBy;
    return unseen.flatMap((h) =>
      droppedAs(
        [h.block],
        by === undefined || by === null
          ? NO_OWN_WORDS
          : h.attempt === by
            ? NOT_DELIVERED
            : REFUSED_ANSWER,
      ),
    );
  }
}
