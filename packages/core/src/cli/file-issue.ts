/**
 * The door this layer is: a filing is read against the kind it names before
 * anything is written, and what comes back is either the refusal or the
 * issue.
 *
 * A stricter front-end over `issues/create-service.ts`, which does not move.
 * Required-here is this door's own policy and never a domain invariant: the
 * REST route and `forge_issues` both take `category` as optional and store
 * `null`, and pushing the requirement down would refuse every caller that
 * legitimately omits it.
 */

import { findDuplicateIssue } from '../assistant/tools/issue-dedup.js';
import { db } from '../db/client.js';
import {
  type CreateIssueInput,
  type CreateIssueResult,
  createIssue,
  type IssueCreateWriter,
} from '../issues/create-service.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { duplicateRefusal, noticeFor, shapeRefusal } from './refusal.js';
import { type CliGapKind, readFiling } from './shape.js';

/** How far from the chat door this one sets its own dial. The policy is per-door even where the detector is shared. */
export const CLI_DUPLICATE_THRESHOLD = 0.6;
export const CLI_DUPLICATE_CORPUS = 200;

/** The one word both doors use for "I have looked and this is not that issue". */
export const CLI_DEDUP_OVERRIDE = 'confirmNotDuplicate';

export interface CliFiling {
  readonly projectId: string;
  readonly prefixes: readonly string[];
  readonly activePrefix: string | null;
  readonly title: string;
  readonly body: string | null;
  /** Required HERE. Absent is a refusal, not a default. */
  readonly category?: string | null | undefined;
  readonly complexity?: string | null | undefined;
  readonly priority?: string | undefined;
  readonly status?: string | undefined;
  readonly relations?: CreateIssueInput['relations'];
}

export type CliFilingResult =
  | {
      readonly filed: false;
      readonly refusal: string;
      /** Which rule refused first, for a caller that must not read the prose. */
      readonly because: CliGapKind;
      readonly duplicate: string | null;
    }
  | {
      readonly filed: true;
      /** What the body was read as and what it left out. Never a refusal. */
      readonly notice: string | null;
      /** Narrowed: a `filed: true` answer can only ever carry a row that was written. */
      readonly created: Extract<CreateIssueResult, { deduped: false }>;
    };

export interface CliFilingOptions {
  readonly threshold?: number;
  readonly corpus?: number;
  /** The caller saying it has read the match and this is a different problem. */
  readonly confirmNotDuplicate?: boolean;
}

export async function fileIssueThroughCli(
  filing: CliFiling,
  writer: IssueCreateWriter,
  options: CliFilingOptions = {},
): Promise<CliFilingResult> {
  const read = readFiling({
    title: filing.title,
    body: filing.body,
    category: filing.category ?? null,
    prefixes: filing.prefixes,
  });
  const refusal = shapeRefusal(read);
  if (refusal) {
    return {
      filed: false,
      refusal,
      because: read.gaps[0]?.because ?? 'body',
      duplicate: null,
    };
  }

  const duplicate = await findDuplicateIssue(
    db,
    {
      projectId: filing.projectId,
      title: filing.title,
      description: filing.body ?? '',
    },
    {
      threshold: options.threshold ?? CLI_DUPLICATE_THRESHOLD,
      corpus: options.corpus ?? CLI_DUPLICATE_CORPUS,
    },
  );
  if (duplicate && !options.confirmNotDuplicate) {
    const seen = {
      key: formatIssueRef(filing.activePrefix, duplicate.issSeq),
      title: duplicate.title,
    };
    return {
      filed: false,
      refusal: duplicateRefusal(seen, CLI_DEDUP_OVERRIDE),
      because: 'duplicate',
      duplicate: seen.key,
    };
  }

  const created = await createIssue(
    {
      projectId: filing.projectId,
      title: filing.title,
      description: filing.body,
      category: filing.category ?? null,
      complexity: filing.complexity ?? null,
      priority: filing.priority,
      status: filing.status,
      relations: filing.relations,
    },
    writer,
  );
  if (created.deduped) {
    const key = created.existingIssueDisplayId ?? created.existingIssueId;
    return {
      filed: false,
      refusal:
        `Hold — ${key} already holds this filing's detector key, so nothing was created.` +
        ` Read it first: a second issue under one key is what that key exists to prevent.`,
      because: 'detector',
      duplicate: created.existingIssueDisplayId,
    };
  }

  return {
    filed: true,
    notice: noticeFor({ kind: read.kind?.kind ?? '', left: read.left }),
    created,
  };
}
