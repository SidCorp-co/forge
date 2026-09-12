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
import { duplicateRefusal, noticeFor, shapeRefusal } from './refusal.js';
import { type CliGapKind, readFiling } from './shape.js';

/** How far from the chat door this one sets its own dial. The policy is per-door even where the detector is shared. */
export const CLI_DUPLICATE_THRESHOLD = 0.6;
export const CLI_DUPLICATE_CORPUS = 200;

/** The one word both doors use for "I have looked and this is not that issue". */
export const CLI_DEDUP_OVERRIDE = 'confirmNotDuplicate';

// cm:guard this type IS the door, and a field `CreateIssueInput` accepts that is absent here is deliberately out of reach rather than forgotten — adding one is a decision about what may be filed through a stricter front-end, never a passthrough. `relations` is on it because the parts refusal in `shape.ts` tells a filer to relate the keys in the same create, and a way out the door cannot carry is the defect this layer exists to remove.
export interface CliFiling {
  readonly projectId: string;
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

// cm:guard the shape is read and the duplicate asked BEFORE `createIssue`, and a refusal returns from here rather than from inside it — a layer that files a malformed body and reports success has done nothing, and a duplicate refused after the insert is a duplicate filed
// cm:edge contract -> packages/core/src/issues/one-create-path.test.ts — this door calls `createIssue` and must never grow an `insert(issues)` of its own; that scan is what keeps the stricter front-end from becoming a second write path
export async function fileIssueThroughCli(
  filing: CliFiling,
  writer: IssueCreateWriter,
  options: CliFilingOptions = {},
): Promise<CliFilingResult> {
  const read = readFiling({
    title: filing.title,
    body: filing.body,
    category: filing.category ?? null,
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
    const seen = { key: `ISS-${duplicate.issSeq}`, title: duplicate.title };
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
  // cm:guard a detector-key claim that landed on an EXISTING issue comes back refused by name, never as a filing that happened. `createIssue` answers `deduped: true` with no new row, and a door reporting that as filed is the shape ISS-807 is the standing example of: a call that returns successfully and wrote nothing. This layer sets no `detectorKey`, so the branch is unreachable from `CliFiling` today, and that is exactly why it is written as a loud break rather than left to a caller to notice.
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
