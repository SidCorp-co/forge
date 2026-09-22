/**
 * ISS-1179 — the one statement of which `forge_issues` inputs name an issue, and what a caller
 * may spell into them.
 *
 * The defect this module ends was two copies of that statement with only one of them checked:
 * the tool's description promised `documentId` took a display key, `z.uuid()` refused one, and
 * nothing in the repo compared them. So {@link ISSUE_REF_CLAUSE} is RENDERED from the registries
 * below and the handler ROUTES BY them — a pair named in one and absent from the other cannot be
 * written.
 *
 * The resolution itself is the REST door's, unchanged: `parseIssueRef` over the prefixes
 * `heldIssuePrefixes` returns, then `findIssueByDisplaySeq`. See `issues/routes.ts` at
 * `/:id/issues/by-display/:displayId`.
 */

import { z } from 'zod';
import { heldIssuePrefixes } from '../../issues/issue-prefix-read.js';
import { findIssueByDisplaySeq } from '../../issues/read-service.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../../lib/issue-ref.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { assertPrincipalIsMember, type McpContext, resolveEffectiveProjectId } from './lib.js';

/** One input that names a row: the action it belongs to and the path a caller writes it at. */
export type RefInput = { action: string; field: string };

/**
 * Every `forge_issues` input that names an ISSUE. The handler resolves exactly these and the
 * description sentence names exactly these, because both read this array.
 */
export const ISSUE_REF_INPUTS: readonly RefInput[] = [
  { action: 'get', field: 'documentId' },
  { action: 'update', field: 'documentId' },
  { action: 'transition', field: 'documentId' },
  { action: 'setAttributes', field: 'documentId' },
  { action: 'mark_merged', field: 'data.issueId' },
  { action: 'unmark', field: 'data.issueId' },
  { action: 'createTask', field: 'data.issueId' },
  { action: 'listTasks', field: 'filters.issue' },
];

/**
 * Every `forge_issues` input that names a TASK. A task carries no display key, so these take the
 * uuid alone and refuse a key by name rather than reading it as the issue the key belongs to.
 */
export const TASK_REF_INPUTS: readonly RefInput[] = [
  { action: 'updateTask', field: 'documentId' },
  { action: 'deleteTask', field: 'documentId' },
];

/** `field on actionA/actionB, otherField on actionC` — the registry as a reader meets it. */
function byField(inputs: readonly RefInput[]): string {
  return [...new Set(inputs.map((i) => i.field))]
    .map((field) => {
      const actions = inputs.filter((i) => i.field === field).map((i) => i.action);
      return `${field} on ${actions.join('/')}`;
    })
    .join(', ');
}

/**
 * The sentence the tool's description carries about its references, built from the registries so
 * it cannot name a pair the handler does not route, nor omit one it does.
 */
export const ISSUE_REF_CLAUSE =
  `${byField(ISSUE_REF_INPUTS)} each name an issue and take either its uuid or the display key ` +
  `this tool answers with under issueId (ISS-42 under the shared prefix, whatever prefix the ` +
  `project holds otherwise, or that key's bare sequence number); a key resolves inside the ` +
  `project the call is scoped to, and one that resolves to nothing is refused by name rather ` +
  `than read as absent. ${byField(TASK_REF_INPUTS)} names a TASK and takes its uuid alone.`;

/**
 * What a reference field accepts at parse time. The shape refusals belong to the resolver, not to
 * zod: only the resolver knows which project a key was looked for in and which prefixes that
 * project holds, and those are what a caller needs to be told.
 */
export const issueRefSchema = z.string().trim().min(1).describe(ISSUE_REF_CLAUSE);

const uuidSchema = z.uuid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

function registered(inputs: readonly RefInput[], action: string, field: string): boolean {
  return inputs.some((i) => i.action === action && i.field === field);
}

/** The references one `forge_issues` call may resolve, bound to that call's action and scope. */
export interface CallRefs {
  /** The issue uuid this reference names. */
  issue(field: string, ref: string): Promise<string>;
  /** The task uuid this reference names, refusing a display key by name. */
  task(field: string, ref: string): string;
}

/**
 * The resolver for one call. The project scope is deferred and memoised: a uuid reference costs
 * no lookup at all, so the path every existing caller takes is untouched, and a call resolving
 * two keys reads the project once.
 *
 * Membership of the scoped project is asserted BEFORE any key is looked up. Resolving first would
 * answer whether an issue exists in a project the caller cannot see.
 */
export function refsFor(
  input: { action: string; projectId?: string | undefined },
  ctx: McpContext,
  principal: McpPrincipal,
): CallRefs {
  let scoped: Promise<string> | null = null;
  const scope = (): Promise<string> => {
    scoped ??= (async () => {
      const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
      await assertPrincipalIsMember(principal, projectId);
      return projectId;
    })();
    return scoped;
  };

  return {
    async issue(field, ref) {
      if (!registered(ISSUE_REF_INPUTS, input.action, field)) {
        throw new Error(
          `BAD_REQUEST: ${field} on action '${input.action}' is not one of this tool's issue references — ${ISSUE_REF_CLAUSE}`,
        );
      }
      if (isUuid(ref)) return ref;

      const projectId = await scope();
      const parsed = parseIssueRef(
        ref,
        issueRefNeedsHeldPrefixes(ref) ? await heldIssuePrefixes(projectId) : [],
      );
      if (!parsed.ok) throw new Error(`BAD_REQUEST: ${field} — ${parsed.message}`);

      const row = await findIssueByDisplaySeq(projectId, parsed.issSeq);
      if (!row) {
        throw new Error(
          `NOT_FOUND: ${field} \`${ref}\` is a display key, and this project holds no issue at that number. Nothing was read or written. \`forge_issues action=list\` prints the keys it does hold under issueId.`,
        );
      }
      return row.id;
    },

    task(field, ref) {
      if (!registered(TASK_REF_INPUTS, input.action, field)) {
        throw new Error(
          `BAD_REQUEST: ${field} on action '${input.action}' is not one of this tool's task references — ${ISSUE_REF_CLAUSE}`,
        );
      }
      if (isUuid(ref)) return ref;
      throw new Error(
        `BAD_REQUEST: ${field} on action '${input.action}' is the TASK uuid, and \`${ref}\` is not a uuid. A task carries no display key — a display key names the issue, never one of its tasks. List them with action 'listTasks' and filters.issue, and take the uuid off the row you mean.`,
      );
    },
  };
}
