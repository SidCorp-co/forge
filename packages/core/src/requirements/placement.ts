/**
 * A requirement's place in the product (REQ-29): its business area, from the project's own list, and
 * a short name of at most six words. The assistant proposes both from the product record and a person
 * accepts or changes them; a proposal is never written as the answer, so no row gets an area nobody
 * agreed to.
 */

import { SHORT_NAME_MAX_WORDS, shortNameWords } from '@forge/contracts/requirement-roadmap';
import { type RequirementAreaRef, requirementKey } from '@forge/contracts/requirements';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  requirementAreas,
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { completeOnce } from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { type RequirementActor, rowIn } from './read.js';
import type { RequirementRefusal } from './rules.js';
import { answer, inTx, lockRequirements, type RequirementOutcome } from './write-tx.js';

/** The column's own cap (0486's check): a proposal over it is not stored. */
const SHORT_NAME_MAX_CHARS = 80;

/** The project's areas in the order a list draws them. */
export async function areasOf(projectId: string): Promise<RequirementAreaRef[]> {
  return db
    .select({ id: requirementAreas.id, name: requirementAreas.name })
    .from(requirementAreas)
    .where(eq(requirementAreas.projectId, projectId))
    .orderBy(asc(requirementAreas.position), asc(requirementAreas.name));
}

type AreasOutcome =
  | { ok: true; areas: RequirementAreaRef[] }
  | { ok: false; refusals: RequirementRefusal[] };

/**
 * Replaces the project's list with `names`. A name that stays keeps its row, matched without case,
 * so a change of case renames it in place. A name that goes is deleted only while no requirement
 * holds it or has it proposed: otherwise the list is refused naming those requirements, since
 * deleting the area would leave each with none and say nothing.
 */
export async function setAreas(input: {
  projectId: string;
  actor: RequirementActor;
  names: string[];
}): Promise<AreasOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const names = input.names.map((n) => n.trim());
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    return {
      ok: false,
      refusals: [
        {
          code: 'REQUIREMENT_AREA_DUPLICATE',
          path: '/names',
          detail: 'an area name appears twice in the list; each area is named once',
        },
      ],
    };
  }
  const refusals = await db.transaction(async (tx) => {
    await lockRequirements(tx, projectId);
    const held = await tx
      .select({ id: requirementAreas.id, name: requirementAreas.name })
      .from(requirementAreas)
      .where(eq(requirementAreas.projectId, projectId));
    const kept = new Map(names.map((n, position) => [n.toLowerCase(), { name: n, position }]));
    const gone = held.filter((a) => !kept.has(a.name.toLowerCase()));
    if (gone.length > 0) {
      const holding = await tx
        .select({ seq: requirements.reqSeq, area: requirementAreas.name })
        .from(requirements)
        .innerJoin(
          requirementAreas,
          sql`${requirementAreas.id} IN (${requirements.areaId}, ${requirements.proposedAreaId})`,
        )
        .where(
          and(
            eq(requirements.projectId, projectId),
            inArray(
              requirementAreas.id,
              gone.map((a) => a.id),
            ),
          ),
        )
        .orderBy(asc(requirements.reqSeq));
      if (holding.length > 0) {
        const named = holding.map((h) => `${requirementKey(h.seq)} (${h.area})`).join(', ');
        return [
          {
            code: 'REQUIREMENT_AREA_IN_USE' as const,
            path: '/names',
            detail: `the list leaves out areas that requirements still hold or have proposed: ${named}. Move them to another area first, then remove it`,
          },
        ];
      }
    }
    for (const a of held) {
      const stays = kept.get(a.name.toLowerCase());
      if (stays) {
        await tx
          .update(requirementAreas)
          .set({ name: stays.name, position: stays.position })
          .where(eq(requirementAreas.id, a.id));
      }
    }
    const heldNames = new Set(held.map((a) => a.name.toLowerCase()));
    for (const [key, { name, position }] of kept) {
      if (!heldNames.has(key)) {
        await tx.insert(requirementAreas).values({ projectId, name, position });
      }
    }
    if (gone.length > 0) {
      await tx.delete(requirementAreas).where(
        inArray(
          requirementAreas.id,
          gone.map((a) => a.id),
        ),
      );
    }
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return { ok: true, areas: await areasOf(projectId) };
}

function placementRefusal(
  code: 'REQUIREMENT_AREA_UNKNOWN' | 'REQUIREMENT_SHORT_NAME_TOO_LONG',
  path: string,
  detail: string,
): RequirementRefusal[] {
  return [{ code, path, detail }];
}

/** A person sets the area and short name; a field left out stays, null clears it, and the proposal is answered. */
export async function setPlacement(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  areaId?: string | null | undefined;
  shortName?: string | null | undefined;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  if (input.shortName && shortNameWords(input.shortName) > SHORT_NAME_MAX_WORDS) {
    return {
      ok: false,
      refusals: placementRefusal(
        'REQUIREMENT_SHORT_NAME_TOO_LONG',
        '/shortName',
        `a short name is at most ${SHORT_NAME_MAX_WORDS} words; "${input.shortName}" is ${shortNameWords(input.shortName)}`,
      ),
    };
  }
  if (input.areaId) {
    const [area] = await db
      .select({ id: requirementAreas.id })
      .from(requirementAreas)
      .where(and(eq(requirementAreas.id, input.areaId), eq(requirementAreas.projectId, projectId)))
      .limit(1);
    if (!area) {
      return {
        ok: false,
        refusals: placementRefusal(
          'REQUIREMENT_AREA_UNKNOWN',
          '/areaId',
          `area ${input.areaId} is not one of this project's areas; read them from GET /api/projects/${projectId}/requirement-areas`,
        ),
      };
    }
  }
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    await tx
      .update(requirements)
      .set({
        ...(input.areaId === undefined ? {} : { areaId: input.areaId, proposedAreaId: null }),
        ...(input.shortName === undefined
          ? {}
          : { shortName: input.shortName, proposedShortName: null }),
        updatedAt: sql`now()`,
      })
      .where(eq(requirements.id, row.id));
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}

/** A person takes the assistant's proposal as it stands. */
export async function acceptPlacement(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
}): Promise<RequirementOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  if (!row.proposedAreaId && !row.proposedShortName) {
    return {
      ok: false,
      refusals: [
        {
          code: 'REQUIREMENT_PLACEMENT_NOT_PROPOSED',
          path: '/',
          detail: `${requirementKey(row.reqSeq)} has no proposed area or short name to accept`,
        },
      ],
    };
  }
  await db
    .update(requirements)
    .set({
      areaId: row.proposedAreaId ?? row.areaId,
      shortName: row.proposedShortName ?? row.shortName,
      proposedAreaId: null,
      proposedShortName: null,
      updatedAt: sql`now()`,
    })
    .where(eq(requirements.id, row.id));
  return answer(projectId, row.id, actor, null);
}

const PROMPT =
  'You file one requirement of a software product. Reply with one JSON object and nothing else: ' +
  '{"area": <exactly one of the listed area names>, "shortName": <at most six plain words naming the requirement>}. ' +
  'Pick the area whose business purpose the requirement serves.';

/** The assistant's proposal for one requirement: written beside the real fields, never over them. Quiet on a miss. */
export async function proposePlacement(projectId: string, requirementId: string): Promise<boolean> {
  const areas = await areasOf(projectId);
  const [row] = await db.select().from(requirements).where(eq(requirements.id, requirementId));
  if (!row) return false;
  const wantArea = !row.areaId && !row.proposedAreaId && areas.length > 0;
  const wantName = !row.shortName && !row.proposedShortName;
  if (!wantArea && !wantName) return false;
  const [rev] = await db
    .select({ tldr: requirementRevisions.tldr, spec: requirementRevisions.spec })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, requirementId))
    .orderBy(sql`${requirementRevisions.revision} desc`)
    .limit(1);
  const crit = await db
    .select({ body: requirementCriteria.body })
    .from(requirementCriteria)
    .where(
      and(
        eq(requirementCriteria.requirementId, requirementId),
        isNull(requirementCriteria.retiredRevision),
      ),
    )
    .limit(6);
  const goal = (rev?.spec as { goal?: string } | null)?.goal ?? '';
  const answerOnce = await completeOnce(
    { surface: 'conversation', projectId, what: 'a requirement’s area and short name' },
    [
      { role: 'system', content: PROMPT },
      {
        role: 'user',
        content: [
          `Areas: ${areas.map((a) => a.name).join(' | ') || '(none)'}`,
          `Title: ${row.title}`,
          rev?.tldr ? `Summary: ${rev.tldr}` : '',
          goal ? `Goal: ${goal.slice(0, 600)}` : '',
          ...crit.map((c) => `- ${c.body.slice(0, 160)}`),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    { temperature: 0, signal: AbortSignal.timeout(30_000) },
  );
  if (!answerOnce.ok) {
    logger.warn({ requirementId, miss: answerOnce.miss }, 'requirement placement: no proposal');
    return false;
  }
  let parsed: { area?: unknown; shortName?: unknown };
  try {
    const m = answerOnce.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : '');
  } catch {
    logger.warn({ requirementId }, 'requirement placement: the proposal was not JSON, none stored');
    return false;
  }
  const area = areas.find((a) => a.name === parsed.area);
  const name =
    typeof parsed.shortName === 'string' &&
    shortNameWords(parsed.shortName) <= SHORT_NAME_MAX_WORDS &&
    parsed.shortName.trim().length <= SHORT_NAME_MAX_CHARS
      ? parsed.shortName.trim()
      : null;
  if (!(wantArea && area) && !(wantName && name)) return false;
  // the model call takes seconds: a field a person set meanwhile is theirs, so each proposal is
  // written only where the row still holds neither a value nor a proposal for it
  if (wantArea && area) {
    await db
      .update(requirements)
      .set({ proposedAreaId: area.id })
      .where(
        and(
          eq(requirements.id, requirementId),
          isNull(requirements.areaId),
          isNull(requirements.proposedAreaId),
        ),
      );
  }
  if (wantName && name) {
    await db
      .update(requirements)
      .set({ proposedShortName: name })
      .where(
        and(
          eq(requirements.id, requirementId),
          isNull(requirements.shortName),
          isNull(requirements.proposedShortName),
        ),
      );
  }
  return true;
}

/** A person asks for proposals for every requirement of the project that has none; they arrive one at a time, in the background. */
export async function proposeMissingPlacements(
  projectId: string,
  actor: RequirementActor,
): Promise<{ asked: number }> {
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const rows = await db
    .select({ id: requirements.id })
    .from(requirements)
    .where(
      and(
        eq(requirements.projectId, projectId),
        or(
          and(isNull(requirements.areaId), isNull(requirements.proposedAreaId)),
          and(isNull(requirements.shortName), isNull(requirements.proposedShortName)),
        ),
      ),
    );
  // one model call each, so the answer is the count asked and the proposals arrive on the list as they are made
  void (async () => {
    for (const r of rows) {
      try {
        await proposePlacement(projectId, r.id);
      } catch (err) {
        logger.warn({ err, requirementId: r.id }, 'requirement placement: a proposal failed');
      }
    }
  })();
  return { asked: rows.length };
}
