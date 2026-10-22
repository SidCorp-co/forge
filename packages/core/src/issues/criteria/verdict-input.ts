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
 *   its reason and evidence carry no secret      VERDICT_SECRET (naming the span read as one)
 *
 * A storefront draft names every workflow draft its criterion rests on, each workflow once, and an
 * environment key (VERDICT_STOREFRONT_DRAFT_SHAPE, at the part that is wrong).
 * `commit_unresolved` is not an identity a writer can name: it exists only on backfilled rows.
 */

import type { CriterionProbe } from '@forge/contracts/criterion-probes';
import type { CriterionJudge } from '@forge/contracts/issue-design';
import type { VerdictRefusalCode } from '@forge/contracts/issues';
import {
  STOREFRONT_DRAFT_PARTS_MAX,
  STOREFRONT_DRAFT_SHAPE,
  STOREFRONT_DRAFT_VERSION,
  STOREFRONT_ENVIRONMENT,
  STOREFRONT_WORKFLOW_ID,
  type StorefrontDraftPart,
} from '@forge/contracts/verdict-identity';
import { type SecretSpan, secretSpans } from '@forge/observability';
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
      /** Every workflow draft the criterion rests on; or, for one, `workflowId` and `draftVersion`. */
      readonly workflows?: readonly StorefrontDraftPartInput[] | undefined;
      readonly workflowId?: string | undefined;
      readonly draftVersion?: string | undefined;
      readonly environment: string;
    };

/** One part of a storefront draft as sent: either field may be missing, and is refused by name. */
export interface StorefrontDraftPartInput {
  readonly workflowId?: string | undefined;
  readonly draftVersion?: string | undefined;
}

type StorefrontDraftIdentity = Extract<VerdictIdentity, { kind: 'storefront_draft' }>;

export interface VerdictDraft {
  readonly criterion: number;
  readonly verdict: string;
  readonly reason: string | null;
  readonly identity: VerdictIdentity | null;
  readonly evidence: readonly string[];
  /** QA's judgement of the running build, or the review's; omitted, it is QA's. */
  readonly judge?: CriterionJudge | undefined;
  /** The probe this verdict keeps on its criterion (ISS-469); only the REST door sends one. */
  readonly probe?: CriterionProbe | undefined;
}

export interface VerdictRefusal {
  readonly code: Exclude<VerdictRefusalCode, 'VERDICT_REFUSED'>;
  readonly criterion: number;
  readonly detail: string;
  /** Where in the draft the refused value sits, where its code alone does not say. */
  readonly path?: string;
}

const WHOLE_COMMIT = /^[0-9a-f]{40}$/iu;
const WHOLE_RUNTIME = /^[0-9a-f]{40,64}$/iu;

const blank = (s: string | null | undefined) => !s?.trim();

function refuse(code: VerdictRefusal['code'], criterion: number, detail: string): VerdictRefusal {
  return { code, criterion, detail };
}

const blankOr = (s: string | undefined) => s === undefined || !s.trim();

/**
 * The workflow drafts a storefront identity names, as sent: the `workflows` list, or the one
 * workflow of the one-workflow form, which stays accepted because writers in the field send it
 * (ISS-613 decision). Read only after `storefrontDraftFault` passed it.
 */
export function storefrontPartsOf(identity: StorefrontDraftIdentity): StorefrontDraftPart[] {
  const sent = identity.workflows ?? [
    { workflowId: identity.workflowId, draftVersion: identity.draftVersion },
  ];
  return sent.map((p) => ({
    workflowId: (p.workflowId ?? '').trim(),
    draftVersion: (p.draftVersion ?? '').trim(),
  }));
}

/** What is wrong with one part of a storefront identity, and where, or null where nothing is. */
function partFault(
  part: StorefrontDraftPartInput,
  at: string,
): { path: string; why: string } | null {
  if (blankOr(part.workflowId)) {
    return { path: `${at}/workflowId`, why: 'has no workflowId' };
  }
  if (!STOREFRONT_WORKFLOW_ID.test((part.workflowId ?? '').trim())) {
    return {
      path: `${at}/workflowId`,
      why: `names workflowId \`${part.workflowId}\`, which is not a provider workflow id (letters, digits, \`-\` and \`_\`, at most 100)`,
    };
  }
  if (blankOr(part.draftVersion)) {
    return {
      path: `${at}/draftVersion`,
      why: `names workflow \`${part.workflowId}\` with no draftVersion`,
    };
  }
  if (!STOREFRONT_DRAFT_VERSION.test((part.draftVersion ?? '').trim())) {
    return {
      path: `${at}/draftVersion`,
      why: `names draftVersion \`${part.draftVersion}\`, which is not a draft version id (letters, digits, \`.\`, \`:\`, \`-\` and \`_\`, at most 128)`,
    };
  }
  return null;
}

/** The first thing wrong with a storefront identity's workflow drafts, and where. */
function draftsFault(identity: StorefrontDraftIdentity): { path: string; why: string } | null {
  const single = identity.workflowId !== undefined || identity.draftVersion !== undefined;
  const list = identity.workflows;
  if (list !== undefined && single) {
    return {
      path: '/identity/workflows',
      why: 'names both `workflows` and the one-workflow `workflowId`/`draftVersion`; send one form',
    };
  }
  if (list === undefined) {
    if (!single) return { path: '/identity/workflows', why: 'names no workflow' };
    return partFault(identity, '/identity');
  }
  if (list.length === 0) {
    return { path: '/identity/workflows', why: 'names no workflow: `workflows` is empty' };
  }
  if (list.length > STOREFRONT_DRAFT_PARTS_MAX) {
    return {
      path: '/identity/workflows',
      why: `names ${list.length} workflows, more than the ${STOREFRONT_DRAFT_PARTS_MAX} one verdict holds`,
    };
  }
  const first = new Map<string, number>();
  for (const [i, part] of list.entries()) {
    const wrong = partFault(part, `/identity/workflows/${i}`);
    if (wrong) return wrong;
    const id = (part.workflowId ?? '').trim();
    const seen = first.get(id);
    if (seen !== undefined) {
      return {
        path: `/identity/workflows/${i}/workflowId`,
        why: `names workflow \`${id}\` more than once (parts ${seen} and ${i}); a workflow is judged at one draft`,
      };
    }
    first.set(id, i);
  }
  return null;
}

function storefrontDraftFault(
  criterion: number,
  identity: StorefrontDraftIdentity,
): VerdictRefusal | null {
  const wrong =
    draftsFault(identity) ??
    (STOREFRONT_ENVIRONMENT.test(identity.environment.trim())
      ? null
      : {
          path: '/identity/environment',
          why: `names environment \`${identity.environment}\`, which is not an environment key of the project document (a lowercase slug)`,
        });
  if (!wrong) return null;
  return {
    ...refuse(
      'VERDICT_STOREFRONT_DRAFT_SHAPE',
      criterion,
      `criterion ${criterion}'s storefront draft ${wrong.why}. A storefront draft is ${STOREFRONT_DRAFT_SHAPE}.`,
    ),
    path: wrong.path,
  };
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

/** Characters of context shown before a refused span: enough to show where the read began. */
const SPAN_CONTEXT = 12;

/**
 * Where in `text` the detector read a secret, named so the writer can find it and the secret is not
 * sent back: the offset and length are exact, the context before it is text the detector did not
 * read as secret, and of the span itself only its public scheme (`sk-proj-`, `ghp_`) is shown.
 */
function spanNamed(text: string, span: SecretSpan): string {
  const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
  const before = text.slice(Math.max(lineStart, span.start - SPAN_CONTEXT), span.start);
  const masked = `${span.lead}***`;
  const article = /^[aeiou]/.test(span.shape) ? 'an' : 'a';
  const at = `${article} ${span.shape} at offset ${span.start}, ${span.end - span.start} characters`;
  return before.trim() === '' ? `${at}: \`${masked}\`` : `${at}: \`${masked}\` after \`${before}\``;
}

/**
 * A verdict's words are stored and shown as written, so a secret in them is refused by the one
 * detector every screen asks (`@forge/observability:secretSpans`, which `containsSecret` reads),
 * naming the span it read so a misread id can be told from a key (ISS-614).
 */
function secretFault(draft: VerdictDraft): VerdictRefusal | null {
  const fields: [string, string, string | null][] = [
    ['/reason', 'reason', draft.reason],
    ...draft.evidence.map((e, i): [string, string, string] => [
      `/evidence/${i}`,
      `evidence ${i}`,
      e,
    ]),
  ];
  for (const [path, name, text] of fields) {
    if (text === null) continue;
    const [first, ...more] = secretSpans(text);
    if (!first) continue;
    const others = more.length === 0 ? '' : ` (and ${more.length} more)`;
    const detail = `criterion ${draft.criterion}'s ${name} carries ${spanNamed(text, first)}${others}. Name the credential entry instead.`;
    return { ...refuse('VERDICT_SECRET', draft.criterion, detail), path };
  }
  return null;
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
  const secret = secretFault(draft);
  if (secret) return secret;
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
 * runtime, then commit, then design, then contract. A design written in
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
