/**
 * ISS-55 — what the one-time backfill writes for one issue, decided without a database: the
 * numbered criteria its `acceptance_criteria` text holds, and a row for every verdict block its
 * records name. Everything it cannot represent is a refusal naming the issue, the record and the
 * criterion, which the runner prints; nothing is skipped silently and nothing is guessed.
 *
 *   an abbreviated commit   resolved to the one whole sha the issue itself names that extends it
 *                           (its merge, its head, any whole sha in its comments); otherwise
 *                           `commit_unresolved` on a closed issue (the priced amnesty), and a
 *                           refusal on any other
 *   a design                resolved to the project's workflow by flow or id, at a revision it holds
 */

import type { ForgeRecord } from '../../messaging/forge-record.js';
import { criterionBlocksIn } from '../../messaging/verdict-identity.js';
import type { ActorAgency } from '../actor-agency.js';
import { type ParsedCriterion, parseCriteriaText } from './criteria-text.js';
import { draftFromBlock, verdictDraftFault } from './verdict-input.js';

const SHORT_COMMIT = /^[0-9a-f]{7,39}$/iu;

export interface BackfillIssue {
  readonly id: string;
  readonly status: string;
  readonly acceptanceCriteria: string | null;
  /** Every whole sha the issue itself names, against which an abbreviation is resolved. */
  readonly knownShas: readonly string[];
}

export interface BackfillRecord {
  /** The comment or event the record was read from, for the refusal line. */
  readonly source: string;
  readonly commentId: string | null;
  readonly record: ForgeRecord;
  readonly author: { userId: string | null; deviceId: string | null; agency: ActorAgency };
  readonly createdAt: Date;
}

export interface BackfillDesign {
  readonly id: string;
  readonly revisions: readonly number[];
}

export interface BackfillVerdict {
  readonly n: number;
  readonly verdict: string;
  readonly reason: string | null;
  readonly identityKind: 'commit' | 'runtime' | 'design' | 'commit_unresolved' | null;
  readonly commitSha: string | null;
  readonly runtimeRef: string | null;
  readonly designWorkflowId: string | null;
  readonly designRevision: number | null;
  readonly evidence: readonly string[];
  readonly author: BackfillRecord['author'];
  readonly commentId: string | null;
  readonly createdAt: Date;
}

export interface BackfillPlan {
  readonly criteria: readonly ParsedCriterion[];
  readonly verdicts: readonly BackfillVerdict[];
  readonly refusals: readonly string[];
}

/** The one known whole sha an abbreviation names, or null where none or several extend it. */
function resolveCommit(short: string, known: readonly string[]): string | null {
  const prefix = short.toLowerCase();
  const matches = new Set(known.map((k) => k.toLowerCase()).filter((k) => k.startsWith(prefix)));
  return matches.size === 1 ? ([...matches][0] as string) : null;
}

type Identity = Pick<
  BackfillVerdict,
  'identityKind' | 'commitSha' | 'runtimeRef' | 'designWorkflowId' | 'designRevision'
>;

const NONE: Identity = {
  identityKind: null,
  commitSha: null,
  runtimeRef: null,
  designWorkflowId: null,
  designRevision: null,
};

export function planIssueBackfill(
  issue: BackfillIssue,
  records: readonly BackfillRecord[],
  designs: ReadonlyMap<string, BackfillDesign>,
): BackfillPlan {
  const refusals: string[] = [];
  const at = (source: string | null, n: number | null, why: string) =>
    `issue ${issue.id}${source ? ` record ${source}` : ''}${n === null ? '' : ` criterion ${n}`}: ${why}`;
  const parsed = parseCriteriaText(issue.acceptanceCriteria);
  for (const fault of parsed.faults) refusals.push(at(null, fault.n, fault.why));
  if (parsed.unnumbered) {
    refusals.push(
      at(
        null,
        null,
        'acceptance_criteria holds text and no numbered line, so no criterion was written',
      ),
    );
  }
  const numbers = new Set(parsed.criteria.map((c) => c.n));
  const verdicts: BackfillVerdict[] = [];
  for (const rec of records) {
    for (const block of criterionBlocksIn(rec.record)) {
      if (block.verdict === null) continue;
      const refuse = (why: string) => refusals.push(at(rec.source, block.criterion, why));
      if (!numbers.has(block.criterion)) {
        refuse(`the issue carries no numbered criterion ${block.criterion}`);
        continue;
      }
      const draft = draftFromBlock({ ...block, verdict: block.verdict });
      const id = draft.identity;
      const abbreviated =
        id?.kind === 'commit' && SHORT_COMMIT.test(id.sha.trim()) ? id.sha.trim() : null;
      const fault = verdictDraftFault(draft);
      if (fault && !(fault.code === 'VERDICT_COMMIT_NOT_FULL' && abbreviated)) {
        refuse(`${fault.code}: ${fault.detail}`);
        continue;
      }
      let identity: Identity = NONE;
      if (abbreviated) {
        const whole = resolveCommit(abbreviated, issue.knownShas);
        if (whole) identity = { ...NONE, identityKind: 'commit', commitSha: whole };
        else if (issue.status === 'closed') {
          identity = {
            ...NONE,
            identityKind: 'commit_unresolved',
            commitSha: abbreviated.toLowerCase(),
          };
        } else {
          refuse(
            `commit \`${abbreviated}\` is abbreviated, no whole sha the issue names extends it, and the issue is \`${issue.status}\`, not closed`,
          );
          continue;
        }
      } else if (id?.kind === 'commit') {
        identity = { ...NONE, identityKind: 'commit', commitSha: id.sha.trim().toLowerCase() };
      } else if (id?.kind === 'runtime') {
        identity = { ...NONE, identityKind: 'runtime', runtimeRef: id.ref.trim().toLowerCase() };
      } else if (id?.kind === 'design') {
        const design = designs.get(id.workflow);
        if (!design?.revisions.includes(id.revision)) {
          refuse(
            `design \`${id.workflow}\` rev ${id.revision} is not a workflow revision the issue's project holds`,
          );
          continue;
        }
        identity = {
          ...NONE,
          identityKind: 'design',
          designWorkflowId: design.id,
          designRevision: id.revision,
        };
      }
      verdicts.push({
        n: block.criterion,
        verdict: draft.verdict,
        reason: draft.reason,
        ...identity,
        evidence: draft.evidence,
        author: rec.author,
        commentId: rec.commentId,
        createdAt: rec.createdAt,
      });
    }
  }
  return { criteria: parsed.criteria, verdicts, refusals };
}
