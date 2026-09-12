/**
 * The CLI layer's one filing surface: a stricter front-end over `createIssue`, which does not move.
 *
 * The required category, the shape, the near-duplicate, then the create — in that order, each
 * refusing before the next runs, so a filing that fails one never reaches the table (ISS-985).
 */

import { findDuplicateIssue } from '../assistant/tools/issue-dedup.js';
import { db } from '../db/client.js';
import {
  createIssue,
  type IssueCreateRow,
  type IssueCreateWriter,
} from '../issues/create-service.js';
import type { IssueRelationInput } from '../issues/relations-service.js';
import { kindNeeded } from './kinds.js';
import { duplicateRefusal, shapeRefusal } from './refusal.js';
import { readFiling } from './shape.js';

// cm:why the chat door's 0.72 over 50 rows is a floor tuned to two LLM-written descriptions of one chat message; a person or an agent at the terminal writes the sections, so a lower bar over a wider corpus catches the near-duplicate the chat door would let through — the policy is per-door even where the detector is shared (ISS-985)
export const CLI_DUPLICATE_THRESHOLD = 0.6;
export const CLI_DUPLICATE_CORPUS = 200;

export type CliFiling = {
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly category?: string | null | undefined;
  readonly priority?: string | undefined;
  readonly complexity?: string | null | undefined;
  readonly status?: string | undefined;
  readonly relations?: readonly IssueRelationInput[] | undefined;
};

export type CliFilingAnswer =
  | { readonly filed: false; readonly refusal: string; readonly duplicate: string | null }
  | { readonly filed: true; readonly issue: IssueCreateRow; readonly notice: string | null };

function refused(refusal: string, duplicate: string | null = null): CliFilingAnswer {
  return { filed: false, refusal, duplicate };
}

// cm:guard every refusal below RETURNS — the duplicate check must not run for a filing the shape refused, and `createIssue` must not run for one the duplicate check matched; a check that only appends to a message and falls through files the very body it named
export async function fileIssueThroughCli(
  filing: CliFiling,
  writer: IssueCreateWriter,
): Promise<CliFilingAnswer> {
  const category = filing.category?.trim();
  if (!category) return refused(kindNeeded());

  const read = readFiling({ title: filing.title, body: filing.body, category });
  if (read.gaps.length > 0) return refused(shapeRefusal(read.gaps));

  const same = await findDuplicateIssue(
    db,
    { projectId: filing.projectId, title: filing.title, description: filing.body },
    { threshold: CLI_DUPLICATE_THRESHOLD, corpusSize: CLI_DUPLICATE_CORPUS },
  );
  if (same) return refused(duplicateRefusal(same), `ISS-${same.issSeq}`);

  const result = await createIssue(
    {
      projectId: filing.projectId,
      title: filing.title,
      description: filing.body,
      category,
      priority: filing.priority,
      complexity: filing.complexity,
      status: filing.status,
      relations: filing.relations,
    },
    writer,
  );

  // cm:guard a detector-key dedup is REFUSED by name rather than reported as filed — this layer sets no detectorKey, so the branch is unreachable today and the loud break is what says so if a caller ever passes one through
  if (result.deduped) {
    return refused(
      `Hold — the tracker already holds ${result.existingIssueDisplayId ?? result.existingIssueId}` +
        " under this filing's detector key, so nothing was created.",
      result.existingIssueDisplayId,
    );
  }

  return { filed: true, issue: result.issue, notice: read.notice };
}
