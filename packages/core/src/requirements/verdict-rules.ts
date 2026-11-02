/**
 * What a verdict recorded on a business criterion at the requirement itself must carry (ISS-588), as
 * pure guards over what `verdicts.ts` read. Every rule a verdict on an issue criterion meets is met
 * here too (`issues/criteria/verdict-input.ts:verdictDraftFault`), and three more:
 *
 *   rule                                                        code
 *   the requirement is agreed, in delivery or delivered         REQUIREMENT_VERDICT_NOT_DELIVERING
 *   the criterion is a code with a wording live at the head     REQUIREMENT_VERDICT_CRITERION_UNKNOWN
 *   a pass, short or fail cites what it was taken from          REQUIREMENT_VERDICT_UNCITED
 *
 * and, for one judged on a release rather than a commit (ISS-900), three more:
 *
 *   rule                                                        code
 *   the version is a release version (`0.76.0`, `v0.76.0`)      REQUIREMENT_VERDICT_RELEASE_SHAPE
 *   its project's production names no commit it serves          REQUIREMENT_VERDICT_RELEASE_UNUSED
 *   the project recorded a release shipped under that version   REQUIREMENT_VERDICT_RELEASE_UNKNOWN
 */

import {
  type ReleasedLine,
  type ReleaseIdentityFault,
  releaseIdentityOf,
} from '@forge/contracts/released-line';
import {
  isDeliveringStatus,
  type RecordRequirementVerdictRequest,
} from '@forge/contracts/requirements';
import { verdictDraftFault } from '../issues/index.js';
import type { RequirementRefusal } from './rules.js';

/** Where a shared verdict rule's refusal sits in this body, where the rule names no path itself. */
const SHARED_PATH: Record<string, string> = {
  VERDICT_VALUE_UNKNOWN: '/verdict',
  VERDICT_SKIP_REASON_REQUIRED: '/reason',
  VERDICT_IDENTITY_REQUIRED: '/identity',
  VERDICT_COMMIT_NOT_FULL: '/identity/sha',
};

/**
 * The live criterion the verdict judges, and the release version it names in the stored shape (null
 * where it names a commit, or is a skip), or the refusals that stop it, in the order they are asked.
 * `line` is the project's release line (`release-batch/released-line.ts:releasedLineOf`), null where
 * its production reads the commit it serves or it declares none; `versionOf` reads a version as the
 * record stores it.
 */
export function requirementVerdictRefusals(input: {
  key: string;
  status: string;
  live: readonly { id: string; code: string }[];
  body: RecordRequirementVerdictRequest;
  line: ReleasedLine | null;
  versionOf: (text: string) => string | null;
}):
  | { criterion: { id: string; code: string }; release: string | null }
  | { refusals: RequirementRefusal[] } {
  const { key, status, live, body } = input;
  if (!isDeliveringStatus(status)) {
    return {
      refusals: [
        {
          code: 'REQUIREMENT_VERDICT_NOT_DELIVERING',
          path: '',
          detail: `${key} is ${status}; its criteria are judged on the running build only once it is agreed, in delivery or delivered.`,
        },
      ],
    };
  }
  const criterion = live.find((c) => c.code === body.criterion.toUpperCase());
  if (!criterion) {
    return {
      refusals: [
        {
          code: 'REQUIREMENT_VERDICT_CRITERION_UNKNOWN',
          path: '/criterion',
          detail: `${key} has no live criterion ${body.criterion}; name one of ${live.map((c) => c.code).join(', ') || 'none (it has no live criterion)'}.`,
        },
      ],
    };
  }
  const n = Number(criterion.code.slice(3));
  const evidence = body.evidence ?? [];
  const named = body.identity ?? null;
  const release = named?.kind === 'release' ? named : null;
  const fault = verdictDraftFault({
    criterion: n,
    verdict: body.verdict,
    reason: body.reason ?? null,
    identity: named,
    evidence,
  });
  // a release's shape and place are asked below, against the project's record (`releaseRefusal`)
  if (fault) {
    return {
      refusals: [
        {
          code: fault.code as RequirementRefusal['code'],
          path: fault.path ?? SHARED_PATH[fault.code] ?? '',
          detail: fault.detail.replaceAll(`criterion ${n}`, criterion.code),
        },
      ],
    };
  }
  if (body.verdict !== 'skipped' && evidence.length === 0) {
    return {
      refusals: [
        {
          code: 'REQUIREMENT_VERDICT_UNCITED',
          path: '/evidence',
          detail: `${criterion.code}'s ${body.verdict} cites nothing: name what it was taken from, a link (a clip, a page) or a repository path at the commit judged.`,
        },
      ],
    };
  }
  if (!release || body.verdict === 'skipped') return { criterion, release: null };
  const refused = releaseRefusal(criterion.code, release.version, input);
  return 'refusal' in refused ? { refusals: [refused.refusal] } : { criterion, ...refused };
}

// this door's name for each fault the shared rule reads; keyed on its declared type, so a fault the
// rule gains and this door does not name fails the typecheck rather than passing unnamed
const RELEASE_REFUSALS = {
  shape: 'REQUIREMENT_VERDICT_RELEASE_SHAPE',
  unused: 'REQUIREMENT_VERDICT_RELEASE_UNUSED',
  unknown: 'REQUIREMENT_VERDICT_RELEASE_UNKNOWN',
} as const satisfies Record<ReleaseIdentityFault, RequirementRefusal['code']>;

/** The version a verdict judged on a release names, as stored, or why it is refused (`releaseIdentityOf`). */
function releaseRefusal(
  code: string,
  sent: string,
  input: { line: ReleasedLine | null; versionOf: (text: string) => string | null },
): { release: string } | { refusal: RequirementRefusal } {
  const read = releaseIdentityOf(code, sent, input.line, input.versionOf);
  if ('version' in read) return { release: read.version };
  return { refusal: { code: RELEASE_REFUSALS[read.fault], path: read.path, detail: read.detail } };
}
