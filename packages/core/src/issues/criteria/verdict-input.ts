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
 *   a contract is `<project>/<contract>@<version>`  VERDICT_CONTRACT_SHAPE
 *
 * A storefront draft names a workflow id, a draft version and an environment key (VERDICT_STOREFRONT_DRAFT_SHAPE).
 * `commit_unresolved` is not an identity a writer can name: it exists only on backfilled rows.
 */

import type { VerdictRefusalCode } from '@forge/contracts/issues';
import {
  STOREFRONT_DRAFT_SHAPE,
  STOREFRONT_DRAFT_VERSION,
  STOREFRONT_ENVIRONMENT,
  STOREFRONT_WORKFLOW_ID,
} from '@forge/contracts/verdict-identity';
import { verdictValues } from '../../db/schema-issue-criteria.js';
import {
  type CriterionBlock,
  parseContractIdentity,
  parseDesignIdentity,
  parseStorefrontDraftRuntime,
} from '../../messaging/verdict-identity.js';

export type VerdictIdentity =
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'runtime'; readonly ref: string }
  | { readonly kind: 'design'; readonly workflow: string; readonly revision: number }
  | { readonly kind: 'contract'; readonly ref: string; readonly version: string }
  | {
      readonly kind: 'storefront_draft';
      readonly workflowId: string;
      readonly draftVersion: string;
      readonly environment: string;
    };

export interface VerdictDraft {
  readonly criterion: number;
  readonly verdict: string;
  readonly reason: string | null;
  readonly identity: VerdictIdentity | null;
  readonly evidence: readonly string[];
}

export interface VerdictRefusal {
  readonly code: Exclude<VerdictRefusalCode, 'VERDICT_REFUSED'>;
  readonly criterion: number;
  readonly detail: string;
}

const WHOLE_COMMIT = /^[0-9a-f]{40}$/iu;
const WHOLE_RUNTIME = /^[0-9a-f]{40,64}$/iu;

const blank = (s: string | null | undefined) => !s?.trim();

function refuse(code: VerdictRefusal['code'], criterion: number, detail: string): VerdictRefusal {
  return { code, criterion, detail };
}

function storefrontDraftFault(
  criterion: number,
  identity: Extract<VerdictIdentity, { kind: 'storefront_draft' }>,
): VerdictRefusal | null {
  const wrong = [
    STOREFRONT_WORKFLOW_ID.test(identity.workflowId.trim())
      ? null
      : `workflowId \`${identity.workflowId}\` is not a provider workflow id (letters, digits, \`-\` and \`_\`, at most 100)`,
    STOREFRONT_DRAFT_VERSION.test(identity.draftVersion.trim())
      ? null
      : `draftVersion \`${identity.draftVersion}\` is not a draft version id (letters, digits, \`.\`, \`:\`, \`-\` and \`_\`, at most 128)`,
    STOREFRONT_ENVIRONMENT.test(identity.environment.trim())
      ? null
      : `environment \`${identity.environment}\` is not an environment key of the project document (a lowercase slug)`,
  ].filter((w): w is string => w !== null);
  if (wrong.length === 0) return null;
  return refuse(
    'VERDICT_STOREFRONT_DRAFT_SHAPE',
    criterion,
    `criterion ${criterion} names a storefront draft whose ${wrong.join('; and whose ')}. A storefront draft is ${STOREFRONT_DRAFT_SHAPE}.`,
  );
}

function identityFault(criterion: number, identity: VerdictIdentity): VerdictRefusal | null {
  switch (identity.kind) {
    case 'storefront_draft':
      return storefrontDraftFault(criterion, identity);
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
      return parseContractIdentity(`${identity.ref.trim()}@${identity.version.trim()}`)
        ? null
        : refuse(
            'VERDICT_CONTRACT_SHAPE',
            criterion,
            `criterion ${criterion} names a contract identity that is not \`<project>/<contract>@<version>\`.`,
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
      `criterion ${criterion}'s \`${verdict}\` names nothing it was judged against: a whole commit sha, a runtime, a design (\`<flow> rev <n>\`), a contract (\`<project>/<contract>@<version>\`) or a storefront draft (${STOREFRONT_DRAFT_SHAPE}).`,
    );
  }
  return identityFault(criterion, draft.identity);
}

/**
 * The identity a comment fence's criterion block names, in the order the release hold prefers it
 * (`criteria-verdicts.ts:verdictPairsIn`): runtime, then commit, then design, then contract. A design written in
 * the wrong shape is kept as a malformed draft so its refusal names it.
 *
 */
function identityFromBlock(block: CriterionBlock): VerdictIdentity | null {
  const draft = parseStorefrontDraftRuntime(block.runtime);
  if (draft) return { kind: 'storefront_draft', ...draft, environment: block.environment ?? '' };
  if (block.runtime !== null) return { kind: 'runtime', ref: block.runtime };
  if (block.source !== null) return { kind: 'commit', sha: block.source };
  if (block.design !== null) {
    const design = parseDesignIdentity(block.design);
    return design
      ? { kind: 'design', workflow: design.workflow, revision: design.revision }
      : { kind: 'design', workflow: '', revision: 0 };
  }
  if (block.contract !== null) {
    const contract = parseContractIdentity(block.contract);
    return contract
      ? {
          kind: 'contract',
          ref: `${contract.project}/${contract.contract}`,
          version: contract.version,
        }
      : { kind: 'contract', ref: block.contract, version: '' };
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
