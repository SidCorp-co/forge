/**
 * ISS-55 — what a new criterion verdict must carry, asked by every door alike.
 *
 *   rule                                         code
 *   verdict is pass | short | fail | skipped     VERDICT_VALUE_UNKNOWN
 *   skipped carries a reason                     VERDICT_SKIP_REASON_REQUIRED
 *   pass, short and fail name an identity        VERDICT_IDENTITY_REQUIRED
 *   a commit is a whole 40-hex sha               VERDICT_COMMIT_NOT_FULL
 *   a runtime is a whole object id               VERDICT_RUNTIME_NOT_FULL
 *   a design is `<flow or id> rev <n>`           VERDICT_DESIGN_SHAPE
 *   a contract is `<ref>@<version>`              VERDICT_CONTRACT_SHAPE
 *
 * `commit_unresolved` is not an identity a writer can name: it exists only on backfilled rows.
 */

import { verdictValues } from '../../db/schema-issue-criteria.js';
import { type CriterionBlock, parseDesignIdentity } from '../../messaging/verdict-identity.js';

export type VerdictIdentity =
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'runtime'; readonly ref: string }
  | { readonly kind: 'design'; readonly workflow: string; readonly revision: number }
  | { readonly kind: 'contract'; readonly ref: string; readonly version: string };

export interface VerdictDraft {
  readonly criterion: number;
  readonly verdict: string;
  readonly reason: string | null;
  readonly identity: VerdictIdentity | null;
  readonly evidence: readonly string[];
}

export type VerdictRefusalCode =
  | 'VERDICT_VALUE_UNKNOWN'
  | 'VERDICT_SKIP_REASON_REQUIRED'
  | 'VERDICT_IDENTITY_REQUIRED'
  | 'VERDICT_COMMIT_NOT_FULL'
  | 'VERDICT_RUNTIME_NOT_FULL'
  | 'VERDICT_DESIGN_SHAPE'
  | 'VERDICT_CONTRACT_SHAPE'
  | 'VERDICT_CRITERION_UNKNOWN'
  | 'VERDICT_DESIGN_UNKNOWN';

export interface VerdictRefusal {
  readonly code: VerdictRefusalCode;
  readonly criterion: number;
  readonly detail: string;
}

const WHOLE_COMMIT = /^[0-9a-f]{40}$/iu;
const WHOLE_RUNTIME = /^[0-9a-f]{40,64}$/iu;

const blank = (s: string | null | undefined) => !s?.trim();

function refuse(code: VerdictRefusalCode, criterion: number, detail: string): VerdictRefusal {
  return { code, criterion, detail };
}

function identityFault(criterion: number, identity: VerdictIdentity): VerdictRefusal | null {
  switch (identity.kind) {
    case 'commit':
      return WHOLE_COMMIT.test(identity.sha.trim())
        ? null
        : refuse(
            'VERDICT_COMMIT_NOT_FULL',
            criterion,
            `criterion ${criterion} names commit \`${identity.sha}\`, and a verdict names the whole 40-character sha — an abbreviation cannot be told later from another commit that shares it. Send \`git rev-parse <commit>\`.`,
          );
    case 'runtime':
      return WHOLE_RUNTIME.test(identity.ref.trim())
        ? null
        : refuse(
            'VERDICT_RUNTIME_NOT_FULL',
            criterion,
            `criterion ${criterion} names runtime \`${identity.ref}\`, and a runtime is the whole object id the deployment reports (40 to 64 hex characters).`,
          );
    case 'design':
      return !blank(identity.workflow) &&
        Number.isSafeInteger(identity.revision) &&
        identity.revision >= 1
        ? null
        : refuse(
            'VERDICT_DESIGN_SHAPE',
            criterion,
            `criterion ${criterion} names a design identity that is not \`<workflow flow or id> rev <n>\` with a revision of 1 or more.`,
          );
    case 'contract':
      return !blank(identity.ref) && !blank(identity.version)
        ? null
        : refuse(
            'VERDICT_CONTRACT_SHAPE',
            criterion,
            `criterion ${criterion} names a contract identity that is not \`<ref>@<version>\`.`,
          );
  }
}

/** Why this verdict cannot be written, or null where it can. */
export function verdictDraftFault(draft: VerdictDraft): VerdictRefusal | null {
  const { criterion, verdict } = draft;
  if (!(verdictValues as readonly string[]).includes(verdict)) {
    return refuse(
      'VERDICT_VALUE_UNKNOWN',
      criterion,
      `criterion ${criterion}'s verdict is \`${verdict}\`; a verdict is one of ${verdictValues.map((v) => `\`${v}\``).join(', ')}.`,
    );
  }
  if (verdict === 'skipped' && blank(draft.reason)) {
    return refuse(
      'VERDICT_SKIP_REASON_REQUIRED',
      criterion,
      `criterion ${criterion} is \`skipped\` with no reason. A skip says why the criterion was not judged (a \`why\` line, or \`reason\`); it never counts as a pass.`,
    );
  }
  if (draft.identity === null) {
    if (verdict === 'skipped') return null;
    return refuse(
      'VERDICT_IDENTITY_REQUIRED',
      criterion,
      `criterion ${criterion}'s \`${verdict}\` names nothing it was judged against: a whole commit sha, a runtime, a design (\`<flow> rev <n>\`) or a contract (\`<ref>@<version>\`).`,
    );
  }
  return identityFault(criterion, draft.identity);
}

/**
 * The identity a comment fence's criterion block names, in the order the release hold prefers it
 * (`criteria-verdicts.ts:verdictPairsIn`): runtime, then commit, then design. A design written in
 * the wrong shape is kept as a malformed draft so its refusal names it.
 *
 * cm:seam ISS-60 — `contract: <ref>@<version>` on a fence is ISS-60's block field; once
 * `criterionBlocksIn` carries it, it maps here to `{ kind: 'contract', ref, version }`.
 */
export function identityFromBlock(block: CriterionBlock): VerdictIdentity | null {
  if (block.runtime !== null) return { kind: 'runtime', ref: block.runtime };
  if (block.source !== null) return { kind: 'commit', sha: block.source };
  if (block.design !== null) {
    const design = parseDesignIdentity(block.design);
    return design
      ? { kind: 'design', workflow: design.workflow, revision: design.revision }
      : { kind: 'design', workflow: '', revision: 0 };
  }
  return null;
}

/** The draft a comment fence's criterion block stands for. */
export function draftFromBlock(block: CriterionBlock & { verdict: string }): VerdictDraft {
  return {
    criterion: block.criterion,
    verdict: block.verdict,
    reason: block.why,
    identity: identityFromBlock(block),
    evidence: block.cited,
  };
}
