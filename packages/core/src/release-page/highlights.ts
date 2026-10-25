// A release's highlights as stored and refreshed (REQ-40 BC-2): drafted when the release is cut,
// and again whenever what it may claim changes (its build lands, a verdict is recorded on it). A
// refresh is digest-gated, so unchanged facts are never redrafted, and single-flight, so two
// triggers at once draft once. A read re-judges what is stored against today's facts: highlights
// that no longer hold are never shown, the page says a draft is owed instead.

import { createHash } from 'node:crypto';
import type { Refusal } from '@forge/contracts/refusal';
import {
  highlightMediaOf,
  judgeHighlights,
  type ReleaseHighlight,
  type ReleaseHighlightFacts,
  ReleaseHighlightSchema,
  type ReleaseHighlights,
  type ReleaseMediaRef,
  type ReleaseShownHighlight,
  ReleaseShownHighlightSchema,
} from '@forge/contracts/release-page';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type ReleaseHighlightsRow, releaseHighlights } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { type ClaimReading, claimableByRequirement } from './claims.js';
import type { DraftOutcome } from './draft.js';
import type { RequirementText } from './facts.js';

/** A draft claimed this long ago and never settled is taken over by the next refresh. */
const IN_FLIGHT_MS = 5 * 60_000;
/** A draft the gateway could not answer is tried again on a read no sooner than this. */
const MISS_RETRY_MS = 10 * 60_000;

const byCode = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * What the drafter is shown: each requirement with something the build proves, in its own words, and
 * the media kept of its claims. A file is placed under the requirement its criterion traces, read off
 * the claim of the issue criterion its verdict judged, never matched by code alone: BC-1 of one
 * requirement is not BC-1 of another.
 */
export function highlightFacts(
  version: string,
  requirements: readonly RequirementText[],
  claims: readonly ClaimReading[],
  media: readonly ReleaseMediaRef[],
): ReleaseHighlightFacts {
  const claimable = claimableByRequirement(claims);
  const shown = requirements.filter((r) => (claimable.get(r.key)?.size ?? 0) > 0);
  const requirementOf = (m: ReleaseMediaRef) =>
    claims.find((c) => c.criterion.issueKey === m.issueKey && c.criterion.n === m.criterion.n)
      ?.criterion.requirementKey ?? null;
  return {
    version,
    requirements: shown.map((r) => {
      const codes = [...(claimable.get(r.key) ?? [])].sort(byCode);
      return {
        key: r.key,
        title: r.title,
        text: [r.tldr ?? '', ...[...r.criteria].map(([code, body]) => `${code}: ${body}`)]
          .filter((line) => line.trim() !== '')
          .join('\n'),
        completes: r.completes,
        claimable: codes,
        media: media.filter(
          (m) =>
            requirementOf(m) === r.key && m.criterion.bc !== null && codes.includes(m.criterion.bc),
        ),
      };
    }),
  };
}

/** The clip or picture a highlight of `requirement` claiming `claims` shows: the first kept of them, clips first. */
export function mediaForHighlight(
  facts: ReleaseHighlightFacts,
  requirement: string,
  claims: readonly string[],
): ReleaseMediaRef | null {
  const req = facts.requirements.find((r) => r.key === requirement);
  return req ? (highlightMediaOf(req, claims)[0] ?? null) : null;
}

export function digestOf(facts: ReleaseHighlightFacts): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

export async function highlightsRow(runId: string): Promise<ReleaseHighlightsRow | null> {
  const [row] = await db
    .select()
    .from(releaseHighlights)
    .where(eq(releaseHighlights.runId, runId))
    .limit(1);
  return row ?? null;
}

interface RunRef {
  projectId: string;
  runId: string;
  version: string;
}

async function upsert(
  run: RunRef,
  set: Partial<typeof releaseHighlights.$inferInsert> & {
    state: ReleaseHighlightsRow['state'];
  },
): Promise<void> {
  await db
    .insert(releaseHighlights)
    .values({ projectId: run.projectId, runId: run.runId, version: run.version, ...set })
    .onConflictDoUpdate({
      target: releaseHighlights.runId,
      set: { ...set, version: run.version, updatedAt: sql`now()` },
    });
}

/** Stores the release's highlights as `none`: it proves nothing of any requirement yet. */
export async function storeNone(run: RunRef, digest: string): Promise<void> {
  await upsert(run, { state: 'none', sourceDigest: digest, refusals: [] });
}

/**
 * Claims the draft owed for `digest`: the row goes pending under it, keeping what it held, unless
 * another refresh already claimed the same digest within the in-flight window.
 */
export async function claimDraft(run: RunRef, digest: string): Promise<boolean> {
  const row = await highlightsRow(run.runId);
  const fresh = row && Date.now() - row.updatedAt.getTime() < IN_FLIGHT_MS;
  if (row?.state === 'pending' && row.sourceDigest === digest && fresh) return false;
  await upsert(run, { state: 'pending', sourceDigest: digest });
  return true;
}

/** Settles the claimed draft, unless a newer claim under another digest took the row since. */
export async function settleDraft(
  run: RunRef,
  digest: string,
  outcome: DraftOutcome,
): Promise<void> {
  const mine = and(
    eq(releaseHighlights.runId, run.runId),
    eq(releaseHighlights.sourceDigest, digest),
  );
  const set =
    outcome.kind === 'drafted'
      ? {
          state: 'drafted' as const,
          highlights: outcome.highlights.map(stored),
          model: outcome.model,
          draftedAt: sql`now()`,
          refusals: [],
        }
      : outcome.kind === 'refused'
        ? { state: 'failed' as const, refusals: outcome.refusals, model: outcome.model }
        : // a miss says nothing of the facts, so the next refresh drafts them again
          {
            state: 'failed' as const,
            refusals: [outcome.refusal],
            model: outcome.model,
            sourceDigest: null,
          };
  await db
    .update(releaseHighlights)
    .set({ ...set, updatedAt: sql`now()` })
    .where(mine);
}

/** A highlight as kept: its media without the link a reader is handed, which is minted when it is shown. */
function stored(h: ReleaseHighlight): ReleaseHighlight {
  const { url: _url, poster, ...media } = h.media;
  if (!poster) return { ...h, media: poster === null ? { ...media, poster } : media };
  const { url: _still, ...still } = poster;
  return { ...h, media: { ...media, poster: still } };
}

/**
 * The stored highlights, where every one still parses: a row drafted under an earlier rule (a
 * highlight with no clip, kept before REQ-70 BC-2) reads as none, so the page never shows it.
 */
function storedHighlights(row: ReleaseHighlightsRow): ReleaseHighlight[] | null {
  if (!Array.isArray(row.highlights)) return null;
  const out: ReleaseHighlight[] = [];
  for (const raw of row.highlights) {
    const parsed = ReleaseHighlightSchema.safeParse(raw);
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out.length > 0 ? out : null;
}

export interface ShownHighlights {
  highlights: ReleaseHighlights;
  /** Whether a refresh is owed: no draft answers today's facts, and none is in flight. */
  owed: boolean;
}

const iso = (d: Date) => d.toISOString();

/** The stored highlights where they may still be shown against today's facts; null where they may not. */
function stillShown(
  row: ReleaseHighlightsRow | null,
  facts: ReleaseHighlightFacts,
): ReleaseHighlight[] | null {
  const kept = row ? storedHighlights(row) : null;
  if (!row || !kept || !row.draftedAt || !row.model) return null;
  return judgeHighlights(kept, facts).length === 0 ? kept : null;
}

/**
 * Whether the stored row answers `digest` for good: a refusal for these facts, or highlights that
 * still show. A row drafted for these facts under an earlier rule, which no longer shows, is owed
 * again; without this its digest would call it unchanged and the page would wait on it for ever.
 */
export function answered(
  row: ReleaseHighlightsRow | null,
  facts: ReleaseHighlightFacts,
  digest: string,
): boolean {
  if (row?.sourceDigest !== digest) return false;
  if (row.state === 'failed') return true;
  return row.state === 'drafted' && stillShown(row, facts) !== null;
}

/**
 * Whether a kept highlight still tells the truth about its build (REQ-40 BC-13, REQ-70 BC-5): its
 * requirement is one the release still carries, and each code it claims still has a pass on the
 * build. The one rule a page that ended still answers to, since it is about the build and not about
 * how a highlight is written.
 */
const stillTrue = (h: ReleaseShownHighlight, facts: ReleaseHighlightFacts): boolean => {
  const req = facts.requirements.find((r) => r.key === h.requirement.key);
  return req !== undefined && h.claims.every((c) => req.claimable.includes(c));
};

/**
 * What a release that ended shows (REQ-70): the highlights it ended with, as they were kept, in the
 * shape of their day (one kept before REQ-70 BC-2 may say it has no clip); the refusal it ended on;
 * or none. No rule about how a highlight is written is applied after it ended (media, wording,
 * figures, count), nothing is owed and nothing drafts it again; only a claim its build no longer
 * proves is left out, since a page never claims what the build does not prove.
 */
function endedHighlights(
  row: ReleaseHighlightsRow | null,
  facts: ReleaseHighlightFacts,
  build: string | null,
): ShownHighlights {
  if (row?.state === 'drafted' && row.draftedAt && row.model) {
    const kept: ReleaseShownHighlight[] = [];
    const raws: unknown[] = Array.isArray(row.highlights) ? row.highlights : [];
    for (const [i, raw] of raws.entries()) {
      const parsed = ReleaseShownHighlightSchema.safeParse(raw);
      if (!parsed.success) {
        // a kept row that reads in no shape it was ever written in is said, never shown half
        return {
          highlights: {
            state: 'failed',
            at: iso(row.updatedAt),
            refusals: [
              {
                code: 'RELEASE_HIGHLIGHT_SHAPE',
                path: `highlights.${i}`,
                detail: `the highlights this release ended with do not read as a highlight: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
              },
            ],
          },
          owed: false,
        };
      }
      if (stillTrue(parsed.data, facts)) kept.push(parsed.data);
    }
    if (kept.length > 0)
      return {
        highlights: {
          state: 'drafted',
          highlights: kept,
          model: row.model,
          draftedAt: iso(row.draftedAt),
          sourceDigest: row.sourceDigest ?? digestOf(facts),
        },
        owed: false,
      };
  }
  if (row?.state === 'failed') {
    return {
      highlights: {
        state: 'failed',
        at: iso(row.updatedAt),
        refusals: (row.refusals as Refusal[]).map((r) => ({
          code: r.code,
          path: r.path,
          detail: r.detail,
        })),
      },
      owed: false,
    };
  }
  const why =
    facts.requirements.length > 0
      ? row?.state === 'drafted'
        ? 'what its highlights claimed is no longer proven on its build'
        : 'this release ended before its highlights were drafted'
      : build === null
        ? 'this release has no build yet, so nothing it carries is proven on it'
        : 'no criterion of a requirement this release carries has a pass on its build yet';
  return { highlights: { state: 'none', why }, owed: false };
}

/**
 * What the page shows of the highlights today: `none` where the build proves nothing of any
 * requirement; the stored highlights where they still hold against today's facts (even while a
 * newer draft is owed); the stored refusal where the last draft for these facts failed; otherwise
 * `pending`. A draft a model could not answer shows its refusal, and is owed again after a while.
 */
export function shownHighlights(
  row: ReleaseHighlightsRow | null,
  facts: ReleaseHighlightFacts,
  digest: string,
  build: string | null,
  now: Date = new Date(),
  ended = false,
): ShownHighlights {
  if (ended) return endedHighlights(row, facts, build);
  if (facts.requirements.length === 0) {
    const why =
      build === null
        ? 'this release has no build yet, so nothing it carries is proven on it'
        : 'no criterion of a requirement this release carries has a pass on its build yet';
    return { highlights: { state: 'none', why }, owed: row?.sourceDigest !== digest };
  }
  const answers = row?.sourceDigest === digest;
  const inFlight =
    row?.state === 'pending' && answers && now.getTime() - row.updatedAt.getTime() < IN_FLIGHT_MS;
  const kept = stillShown(row, facts);
  if (row?.draftedAt && row.model && kept) {
    return {
      highlights: {
        state: 'drafted',
        highlights: kept,
        model: row.model,
        draftedAt: iso(row.draftedAt),
        sourceDigest: row.sourceDigest ?? digest,
      },
      owed: !answers && !inFlight,
    };
  }
  // drafted for these facts under an earlier rule, and no longer shown: owed again
  if (row?.state === 'drafted' && answers) {
    return { highlights: { state: 'pending', since: iso(row.updatedAt) }, owed: true };
  }
  if (row?.state === 'failed' && (answers || row.sourceDigest === null)) {
    const retry =
      row.sourceDigest === null && now.getTime() - row.updatedAt.getTime() > MISS_RETRY_MS;
    return {
      highlights: {
        state: 'failed',
        at: iso(row.updatedAt),
        refusals: (row.refusals as Refusal[]).map((r) => ({
          code: r.code,
          path: r.path,
          detail: r.detail,
        })),
      },
      owed: retry,
    };
  }
  return {
    highlights: { state: 'pending', since: iso(row?.updatedAt ?? now) },
    owed: !inFlight,
  };
}

/** Logs a refresh that failed in the background, where nobody awaits it. */
export function refreshFailed(err: unknown, run: { projectId: string; runId: string }): void {
  logger.warn({ err, ...run }, 'release-page: a highlights refresh failed');
}
