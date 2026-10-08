// What Forge read at a release's live deploy bindings, kept (ISS-1282).
//
// A finish closes a probed roster on these rows and on nothing the agent says: the agent decides
// WHEN to look, Forge performs the read, and the row it stores is the evidence. The read itself
// is `verify.ts:readLiveState`; this file only takes it per binding, stores it, and reads it back.

import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { releaseReadings } from '../db/schema-release-ledger.js';
import { bindingName } from './channel.js';
import { ReleaseReadingUnreadableError } from './errors.js';
import type { CloseVerification, ProbedChannel } from './plan.js';
import { type Judgement, judgeReadings } from './reading-judge.js';
import { type LiveState, readLiveCommit, readLiveState } from './verify.js';

/** One live binding's reading: what its probes said, under the name it was read by. */
export interface BindingReading {
  bindingId: string;
  name: string;
  state: LiveState;
}

export interface ReleaseReading {
  id: string;
  runId: string;
  takenAt: Date;
  takenBy: string;
  /** One per live binding that declares a probe, in the order the bindings sort. */
  bindings: BindingReading[];
  /** The live bindings that declare no probe, which this reading did not read. */
  unread: string[];
}

const stringList = z.array(z.string());

const liveStateSchema = z.object({
  health: z.enum(['up', 'down']),
  identity: z.string().nullable(),
  answeredBy: z.array(z.object({ url: z.string(), commit: z.string() })),
  readings: stringList,
  unhealthy: stringList,
  unidentified: stringList,
  disagreement: stringList.nullable(),
});

const bindingsSchema = z.array(
  z.object({ bindingId: z.string(), name: z.string(), state: liveStateSchema }),
);

/** The stored row as a reading, or a refusal naming the row: a shape this code cannot read is
 *  never guessed into one. */
function readingOf(row: typeof releaseReadings.$inferSelect): ReleaseReading {
  const bindings = bindingsSchema.safeParse(row.bindings);
  if (!bindings.success) {
    throw new ReleaseReadingUnreadableError(row.id, `bindings: ${z.prettifyError(bindings.error)}`);
  }
  const unread = stringList.safeParse(row.unread);
  if (!unread.success) {
    throw new ReleaseReadingUnreadableError(row.id, `unread: ${z.prettifyError(unread.error)}`);
  }
  return {
    id: row.id,
    runId: row.runId,
    takenAt: row.takenAt,
    takenBy: row.takenBy,
    bindings: bindings.data,
    unread: unread.data,
  };
}

/**
 * Read every live binding that declares a probe, now, and keep what each said, with the bindings
 * that declare none named beside it as unread.
 */
export async function takeReading(args: {
  runId: string;
  takenBy: string;
  verification: Extract<CloseVerification, { kind: 'probed' }>;
}): Promise<ReleaseReading> {
  const { verification } = args;
  const bindings = await Promise.all(
    verification.channels.map(async (c) => ({
      bindingId: c.bindingId,
      name: bindingName(c),
      state: await readLiveState(c.verify),
    })),
  );
  const [row] = await db
    .insert(releaseReadings)
    .values({
      runId: args.runId,
      takenBy: args.takenBy,
      bindings,
      unread: verification.unread.map(bindingName),
    })
    .returning();
  if (!row) throw new Error(`release batch ${args.runId}: a reading was taken and not stored`);
  return readingOf(row);
}

/** A reading as an answer carries it: each binding beside what its probes said. */
export interface ReadingView {
  id: string;
  takenAt: string;
  takenBy: string;
  bindings: Array<{ bindingId: string; name: string } & LiveState>;
  unread: string[];
}

export function viewOf(reading: ReleaseReading): ReadingView {
  return {
    id: reading.id,
    takenAt: reading.takenAt.toISOString(),
    takenBy: reading.takenBy,
    bindings: reading.bindings.map(({ bindingId, name, state }) => ({ bindingId, name, ...state })),
    unread: reading.unread,
  };
}

/** Every reading of one run, oldest first. */
export async function listReadings(runId: string): Promise<ReleaseReading[]> {
  const rows = await db
    .select()
    .from(releaseReadings)
    .where(eq(releaseReadings.runId, runId))
    .orderBy(asc(releaseReadings.takenAt), asc(releaseReadings.id));
  return rows.map(readingOf);
}

/** What each probed binding was serving before anything moved, by binding id: the one evidence of
 *  the build a release replaced that predates the agent. `null` where it answered no commit. */
export type CommitsBefore = Record<string, string | null>;

export async function readCommitsBefore(
  channels: readonly ProbedChannel[],
): Promise<CommitsBefore> {
  const read = await Promise.all(
    channels.map(async (c) => [c.bindingId, await readLiveCommit(c.verify)] as const),
  );
  return Object.fromEntries(read);
}

/** `commitBeforeBy` off a run's metadata. A run opened without one recorded nothing before, which
 *  the judge says by name where a claimless finish would have needed it. */
export function commitsBeforeOf(metadata: unknown): CommitsBefore {
  const raw = (metadata as { commitBeforeBy?: unknown } | null)?.commitBeforeBy;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).map(([id, commit]) => [id, typeof commit === 'string' ? commit : null]),
  );
}

/**
 * Whether the readings recorded on this run show it live, judged from the database alone — no
 * request is made, so the finish door may call it inline. `claim` is the whole sha the finish names,
 * or `null` to ask only that every binding's build moved.
 */
export async function judgeRecordedReadings(args: {
  runId: string;
  metadata: unknown;
  verification: Extract<CloseVerification, { kind: 'probed' }>;
  claim: string | null;
  now?: number | undefined;
}): Promise<Judgement> {
  return judgeReadings({
    bindings: args.verification.channels.map((c) => ({
      bindingId: c.bindingId,
      name: bindingName(c),
      stableReads: c.verify.stableReads ?? 2,
    })),
    readings: await listReadings(args.runId),
    commitsBefore: commitsBeforeOf(args.metadata),
    claim: args.claim,
    now: args.now ?? Date.now(),
  });
}
