/**
 * The list a requirement page or the BA door opens: each suggestion's view, and on a proposed
 * breakdown the reading of its slices a person judges it by (ISS-278).
 */

import type {
  SuggestionListResponse,
  SuggestionStatus,
  SuggestionView,
} from '@forge/contracts/suggestions';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { breakdownReadIn } from './breakdown-read.js';
import { onTarget, type Row, viewOf } from './read.js';
import { resolveTarget, type SuggestionTargetRef } from './target.js';

async function listedViewOf(projectId: string, row: Row): Promise<SuggestionView> {
  const view = viewOf(row);
  if (row.kind !== 'breakdown' || row.status !== 'proposed' || !row.requirementId) return view;
  return { ...view, breakdown: await breakdownReadIn(db, projectId, row) };
}

export async function listSuggestions(input: {
  projectId: string;
  userId: string;
  target?: SuggestionTargetRef | undefined;
  statuses?: readonly SuggestionStatus[] | undefined;
  limit?: number | undefined;
}): Promise<SuggestionListResponse> {
  await requireCan(actorFor(input.userId), 'project.read', projectResource(input.projectId));
  const target = input.target
    ? await resolveTarget(input.projectId, input.target, input.userId)
    : null;
  const scoped = and(
    eq(suggestions.projectId, input.projectId),
    target ? onTarget(target) : undefined,
  );
  const rows = await db
    .select()
    .from(suggestions)
    .where(
      and(
        scoped,
        input.statuses?.length ? inArray(suggestions.status, [...input.statuses]) : undefined,
      ),
    )
    .orderBy(desc(suggestions.createdAt))
    .limit(input.limit ?? 100);
  const [open] = await db
    .select({ n: count() })
    .from(suggestions)
    .where(and(scoped, eq(suggestions.status, 'proposed')));
  const views = await Promise.all(rows.map((row) => listedViewOf(input.projectId, row)));
  return { suggestions: views, open: open?.n ?? 0 };
}
