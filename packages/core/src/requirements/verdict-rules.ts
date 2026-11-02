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
  isDeliveringStatus,
  type RecordRequirementVerdictRequest,
} from '@forge/contracts/requirements';
import { verdictDraftFault } from '../issues/index.js';
import type { RequirementRefusal } from './rules.js';
import type { ReleasedLine } from './standing-identity.js';

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
    identity: named?.kind === 'commit' ? named : null,
    evidence,
  });
  // a release is an identity the shared rule does not know: its own rules below ask it instead, and
  // the shared rule's last question, whether any identity is named, is answered by it
  if (fault && !(release && fault.code === 'VERDICT_IDENTITY_REQUIRED')) {
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

/** The version a verdict judged on a release names, as stored, or why it is refused. */
function releaseRefusal(
  code: string,
  sent: string,
  input: { line: ReleasedLine | null; versionOf: (text: string) => string | null },
): { release: string } | { refusal: RequirementRefusal } {
  const refuse = (
    refusal: RequirementRefusal['code'],
    path: string,
    detail: string,
  ): { refusal: RequirementRefusal } => ({ refusal: { code: refusal, path, detail } });
  const version = input.versionOf(sent);
  if (!version) {
    return refuse(
      'REQUIREMENT_VERDICT_RELEASE_SHAPE',
      '/identity/version',
      `${code} names release \`${sent}\`, which is no release version: send MAJOR.MINOR.PATCH (e.g. 0.76.0), with or without a leading \`v\`, as the app reported it.`,
    );
  }
  const { line } = input;
  if (!line) {
    return refuse(
      'REQUIREMENT_VERDICT_RELEASE_UNUSED',
      '/identity/kind',
      `${code} names release ${version}, and this project's production reads the commit it serves (or it declares no production environment), so a verdict there names the commit judged: send { kind: 'commit', sha: <40 hex> }.`,
    );
  }
  if (!line.shipped.has(version)) {
    return refuse(
      'REQUIREMENT_VERDICT_RELEASE_UNKNOWN',
      '/identity/version',
      line.live
        ? `${code} names release ${version}, and this project recorded no release shipped under it; its record says ${line.live.version} is live: name the version the app reported, or record that release first (POST /api/projects/:id/release-records).`
        : `${code} names release ${version}, and this project has recorded no release as shipped yet: record the release production serves first (POST /api/projects/:id/release-records), then judge it.`,
    );
  }
  return { release: version };
}
