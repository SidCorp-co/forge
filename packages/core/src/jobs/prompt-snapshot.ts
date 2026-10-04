import crypto from 'node:crypto';
import type { PreambleBlock } from '@forge/contracts/jobs';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { estimateTokens } from '../lib/token-estimator.js';
import { logger } from '../observability/logger.js';

interface PersistPromptSnapshotArgs {
  jobId: string;
  systemPrompt: string;
  userPrompt: string;
  blocks: PreambleBlock[];
  model: string;
}

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
    logger.warn({ err, jobId: args.jobId }, 'prompt-snapshot: persist failed, continuing dispatch');
  }
}
