import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import type { PreambleBlock } from '../lib/chat-preamble.js';
import { estimateTokens } from '../lib/token-estimator.js';
import { logger } from '../logger.js';

export interface PersistPromptSnapshotArgs {
  jobId: string;
  systemPrompt: string;
  userPrompt: string;
  blocks: PreambleBlock[];
  model: string;
}

/**
 * Persist the per-job prompt snapshot used by Surface A (Inspector) +
 * Surface C (block-contribution analytics). Performs two writes:
 *
 *   1. UPSERT into `prompt_blobs` keyed by sha256(systemPrompt) and
 *      atomically increment `ref_count` so dedupe stays accurate under
 *      concurrent dispatch.
 *   2. UPDATE the `jobs` row with the hash + user-prompt snapshot +
 *      token estimate + resolved model id + structured block breakdown.
 *
 * Observability-only — any failure is logged at warn and swallowed so the
 * dispatch path is never blocked on a transient storage hiccup.
 */
export async function persistPromptSnapshot(args: PersistPromptSnapshotArgs): Promise<void> {
  try {
    const hash = crypto.createHash('sha256').update(args.systemPrompt).digest('hex');
    await db.execute(sql`
      INSERT INTO prompt_blobs (hash, content, ref_count)
      VALUES (${hash}, ${args.systemPrompt}, 1)
      ON CONFLICT (hash) DO UPDATE SET ref_count = prompt_blobs.ref_count + 1
    `);
    await db
      .update(jobs)
      .set({
        systemPromptHash: hash,
        userPromptSnapshot: args.userPrompt,
        promptInputTokenEst: estimateTokens(args.systemPrompt + args.userPrompt),
        modelUsed: args.model,
        promptBlocks: args.blocks,
      })
      .where(eq(jobs.id, args.jobId));
  } catch (err) {
    logger.warn(
      { err, jobId: args.jobId },
      'prompt-snapshot: persist failed, continuing dispatch',
    );
  }
}
