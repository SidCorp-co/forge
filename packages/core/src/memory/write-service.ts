import { articleFor } from '@forge/contracts/articles';
import type { CurationWarning } from '@forge/contracts/knowledge';
import { MEMORY_AUTHORED_SOURCES, type MemoryRefusalCode } from '@forge/contracts/memory';
import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { fencedProjectIds } from '../credentials/pat-scope.js';
import { db } from '../db/client.js';
import { memories, memorySources } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';
import { curationOf, isCuratedSource, memoryCurationInputSchema } from './curation.js';
import {
  embedForIndex,
  heldSubject,
  type IndexResult,
  indexMemory,
  MAX_EMBED_CHARS,
} from './indexer.js';
import { type LandedAs, landingOfMirrorWrite } from './issue-learning.js';
import { latestRevisionId } from './revisions-service.js';

/**
 * Shared service for writing a memory row, behind REST `POST /api/memory`.
 *
 * Does NOT check authorization — callers MUST verify project membership
 * before invoking.
 */

export const writeMemoryInputSchema = z
  .object({
    projectId: z.uuid(),
    source: z.enum(memorySources),
    sourceRef: z.string().trim().min(1).max(512),
    textContent: z.string().trim().min(1).max(100_000),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** The entry this write updates, by its id or its sourceRef (REQ-89 BC-1, BC-2). */
    updates: z.string().trim().min(1).max(512).optional(),
  })
  .extend(memoryCurationInputSchema.shape);

type WriteMemoryInput = z.infer<typeof writeMemoryInputSchema>;

const refuse = refuser<MemoryRefusalCode>('MEMORY_REFUSED');

const AGENT_AUTHORED_SOURCES = new Set<string>(['note', 'knowledge', 'policy']);

const MAX_CODE_BLOCK_LINES = 5;

/** Returns the line count of the longest fenced (```/~~~) block, 0 if none. */
function longestFencedBlockLines(text: string): number {
  let longest = 0;
  let openFence: string | null = null;
  let blockLines = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimStart();
    const fence = line.match(/^(`{3,}|~{3,})/)?.[1] ?? null;
    if (openFence === null) {
      if (fence) {
        openFence = fence[0] === '`' ? '```' : '~~~';
        blockLines = 0;
      }
    } else if (fence?.startsWith(openFence)) {
      openFence = null;
      longest = Math.max(longest, blockLines);
    } else {
      blockLines += 1;
    }
  }
  // Unterminated fence: everything after the opener is the block.
  if (openFence !== null) longest = Math.max(longest, blockLines);
  return longest;
}

function assertAgentMemoryQuality(input: WriteMemoryInput): void {
  if (!AGENT_AUTHORED_SOURCES.has(input.source)) return;
  if (input.textContent.length > MAX_EMBED_CHARS) {
    throw refuse(
      'MEMORY_TEXT_TOO_LONG',
      `textContent is ${input.textContent.length} chars but agent-authored memory (${input.source}) is capped at ${MAX_EMBED_CHARS} — the embedding window; anything past it would be stored yet unsearchable. Tighten to facts + pointers, or split into multiple sourceRefs.`,
      '/textContent',
    );
  }
  const blockLines = longestFencedBlockLines(input.textContent);
  if (blockLines > MAX_CODE_BLOCK_LINES) {
    throw refuse(
      'MEMORY_CODE_BLOCK_TOO_LONG',
      `textContent contains ${articleFor(String(blockLines))} ${blockLines}-line fenced code block (max ${MAX_CODE_BLOCK_LINES}). Memory stores logic, not code — copied code rots on the next commit. Replace the block with a one-sentence invariant + a file:line or SHA pointer; one-line runnable commands (verify, query) are fine.`,
      '/textContent',
    );
  }
}

/**
 * What a rewrite under an existing ref keeps of the row it replaces: the corrections people made
 * (MJ-1). A row a person retired is refused, not revived — the upsert would otherwise clear the
 * retirement and its reason in silence.
 */
async function carriedFromExisting(input: WriteMemoryInput): Promise<Carried> {
  const [row] = await db
    .select({ id: memories.id, metadata: memories.metadata, archivedAt: memories.archivedAt })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, input.projectId),
        eq(memories.source, input.source),
        eq(memories.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);
  if (!row) return { carried: {}, existing: null };
  const md = (row.metadata ?? {}) as Record<string, unknown>;
  const retired = md.retired as { at?: unknown; reason?: unknown } | undefined;
  if (row.archivedAt !== null && retired) {
    throw refuse(
      'MEMORY_ALREADY_RETIRED',
      `${input.source} ${input.sourceRef} was retired by a person at ${String(retired.at)} ("${String(retired.reason)}"); write what is true now under a new sourceRef`,
      '/sourceRef',
    );
  }
  return {
    carried: Array.isArray(md.corrections) ? { corrections: md.corrections } : {},
    existing: { id: row.id },
  };
}

interface Carried {
  carried: Record<string, unknown>;
  /** The row this write lands on, when one already holds the ref; null for a fresh write. */
  existing: { id: string } | null;
}

/** Who is writing, stamped on the row as `metadata.writtenBy` (MJ-2). */
interface WriteBy {
  writtenBy?: string | undefined;
}

/**
 * Said on a write that landed on a row already holding its (source, sourceRef) (ISS-789): the write
 * replaced that entry's body. `revisionId` names the revision that kept the earlier text, readable at
 * `GET /api/memory/revisions?projectId=&memoryId=<id>`; null when nothing was kept (the text was
 * the same, or the source keeps no revisions because it mirrors another record).
 */
export interface MemoryReplaced {
  revisionId: string | null;
}

/**
 * Said on a write that landed on the entry already holding its subject rather than on the ref it
 * named (REQ-89 BC-2): the entry `updates` named, or the live entry of the same source whose text is
 * near-identical (`score`, cosine). Its old text is kept as a revision (`replaced`).
 */
export interface MemoryLandedOn {
  id: string;
  sourceRef: string;
  score: number | null;
  reason: string;
}

/** What a write answers: the row, where it landed when that is not the ref it named, that it replaced one, and each curation answer it owes. */
export type MemoryWriteResult = IndexResult & {
  landedAs?: LandedAs;
  landedOn?: MemoryLandedOn;
  replaced?: MemoryReplaced;
  warnings?: CurationWarning[];
};

/**
 * A decision in force has one home, and memory is not it (ISS-1063): memory holds findings and leads
 * that lapse, so a decision written here would be served beside unverified notes and retire with
 * them. The rows written before stay readable; a new one is refused, naming the doors that hold one
 * which its caller reaches: a token fenced to projects never opens the organisation's knowledge, so
 * it is sent to the project's rule and a person to the organisation's.
 */
function refuseDecision(input: WriteMemoryInput): void {
  if (input.source !== 'decision') return;
  const rule = `PUT /api/projects/${input.projectId}/knowledge/<slug> with kind rule`;
  const where =
    fencedProjectIds() === null
      ? `${rule}, or PUT /api/orgs/<orgId>/knowledge/<slug> for the organisation`
      : rule;
  throw refuse(
    'MEMORY_DECISION_NOT_MEMORY',
    `memory does not hold decisions in force: write a decision as a rule, a knowledge entry of kind rule (${where}), or as a requirement (POST /api/projects/${input.projectId}/requirements); a finding or lead goes to memory with source note`,
    '/source',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The entry `updates` names in this project, by id or sourceRef, among the curated sources; refused by name where none. */
async function namedEntry(input: WriteMemoryInput, updates: string) {
  const [row] = await db
    .select({ id: memories.id, source: memories.source, sourceRef: memories.sourceRef })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, input.projectId),
        inArray(memories.source, [...MEMORY_AUTHORED_SOURCES]),
        UUID.test(updates)
          ? or(eq(memories.id, updates), eq(memories.sourceRef, updates))
          : eq(memories.sourceRef, updates),
      ),
    )
    .limit(1);
  if (!row) {
    throw refuse(
      'MEMORY_NOT_FOUND',
      `\`updates\` names ${updates.slice(0, 80)}, which is no memory of this project; name an entry by its id or sourceRef (GET /api/memory/entries), or leave \`updates\` out for a new subject`,
      '/updates',
    );
  }
  return row;
}

/** Whether the project already holds the ref this write names. */
async function holdsRef(input: WriteMemoryInput): Promise<boolean> {
  const [row] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, input.projectId),
        eq(memories.source, input.source),
        eq(memories.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Where a curated write lands (REQ-89 BC-2): on the entry `updates` names; on its own ref where the
 * project holds it; else on the live entry of the same source already holding its subject, so a save
 * on a held subject updates that entry instead of adding a second. The text's vector, where it was
 * embedded to find that entry, is handed on so the write embeds it once.
 */
async function landingOfCuratedWrite(input: WriteMemoryInput): Promise<{
  input: WriteMemoryInput;
  vector?: number[] | null;
  landedOn: MemoryLandedOn | null;
}> {
  if (input.updates) {
    const row = await namedEntry(input, input.updates);
    const moved = row.source !== input.source || row.sourceRef !== input.sourceRef;
    return {
      input: {
        ...input,
        source: row.source as WriteMemoryInput['source'],
        sourceRef: row.sourceRef,
      },
      landedOn: moved
        ? { id: row.id, sourceRef: row.sourceRef, score: null, reason: 'the entry `updates` named' }
        : null,
    };
  }
  if (await holdsRef(input)) return { input, landedOn: null };
  const vector = await embedForIndex({ ...input, text: input.textContent });
  if (vector === null) return { input, vector, landedOn: null };
  const held = await heldSubject(input, vector);
  if (!held) return { input, vector, landedOn: null };
  return {
    input: { ...input, sourceRef: held.sourceRef },
    vector,
    landedOn: {
      ...held,
      reason: `${held.sourceRef} already holds this subject (similarity ${held.score.toFixed(2)}), so the write updated it instead of adding a second entry; its earlier text is kept as a revision`,
    },
  };
}

const ISSUE_KEY = /\b([A-Z][A-Z0-9]{0,15}-[1-9]\d{0,8})\b/;

/**
 * A temporary note names what ends it (REQ-89 BC-5): one ending with an issue is written for that
 * issue, so it retires when the issue closes or drops (`note-lifetime.ts`).
 */
function endsWithIssue(input: WriteMemoryInput): Record<string, unknown> {
  const md = input.metadata ?? {};
  if (input.source !== 'note' || !input.endsWhen || md.about || md.issueId) return {};
  const key = ISSUE_KEY.exec(input.endsWhen)?.[1];
  return key ? { about: key } : {};
}

export async function runMemoryWrite(
  given: WriteMemoryInput,
  by: WriteBy = {},
): Promise<MemoryWriteResult> {
  refuseDecision(given);
  const mirrored = await landingOfMirrorWrite(given);
  assertAgentMemoryQuality(mirrored.input);
  const curated = isCuratedSource(mirrored.input.source);
  const { input, vector, landedOn } = curated
    ? await landingOfCuratedWrite(mirrored.input)
    : { input: mirrored.input, vector: undefined, landedOn: null };
  const { carried, existing } = await carriedFromExisting(input);
  const revisionBefore = existing ? await latestRevisionId(existing.id) : null;
  const said = curated ? curationOf(input) : null;
  const metadata = {
    ...(input.metadata ?? {}),
    ...endsWithIssue(input),
    ...carried,
    ...(by.writtenBy ? { writtenBy: by.writtenBy } : {}),
    ...(said ? { curation: said.curation } : {}),
  };
  const written = await indexMemory({
    projectId: input.projectId,
    source: input.source,
    sourceRef: input.sourceRef,
    text: input.textContent,
    metadata,
    ...(vector !== undefined ? { vector } : {}),
  });
  const replaced: MemoryReplaced | undefined = existing
    ? { revisionId: await keptRevision(written.id, revisionBefore) }
    : undefined;
  return {
    ...written,
    ...(mirrored.landedAs ? { landedAs: mirrored.landedAs } : {}),
    ...(landedOn ? { landedOn } : {}),
    ...(replaced ? { replaced } : {}),
    ...(said && said.warnings.length > 0 ? { warnings: said.warnings } : {}),
  };
}

/** The revision this write made, or null when the newest one is the one that stood before it. */
async function keptRevision(memoryId: string, before: string | null): Promise<string | null> {
  const after = await latestRevisionId(memoryId);
  return after === before ? null : after;
}
