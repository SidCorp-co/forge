/**
 * ISS-1179 — which `forge_issues` inputs name an issue, and what a caller may spell into them.
 * Two copies of that claim with only one of them checked is the defect: the description promised
 * `documentId` took a display key while `z.uuid()` refused one. So {@link ISSUE_REF_CLAUSE} is
 * RENDERED from the registries below and the handler ROUTES BY them. Resolution is the REST
 * by-display door's, unchanged — `parseIssueRef` over `heldIssuePrefixes`, `findIssueByDisplaySeq`.
 */

import { z } from 'zod';
import { heldIssuePrefixes } from '../../issues/issue-prefix-read.js';
import { findIssueByDisplaySeq } from '../../issues/read-service.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../../lib/issue-ref.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { assertPrincipalIsMember, type McpContext, resolveEffectiveProjectId } from './lib.js';

export type RefInput = { action: string; field: string };

/** The inputs naming an ISSUE: the clause states these and the handler resolves these. */
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

/** The inputs naming a TASK. Nothing renders a display key for one, so the uuid is all there is. */
export const TASK_REF_INPUTS: readonly RefInput[] = [
  { action: 'updateTask', field: 'documentId' },
  { action: 'deleteTask', field: 'documentId' },
];

function byField(inputs: readonly RefInput[]): string {
  return [...new Set(inputs.map((i) => i.field))]
    .map((field) => {
      const actions = inputs.filter((i) => i.field === field).map((i) => i.action);
      return `${field} on ${actions.join('/')}`;
    })
    .join(', ');
}

/** What the tool's description says about its references, so it cannot state a pair it does not route. */
export const ISSUE_REF_CLAUSE =
  `${byField(ISSUE_REF_INPUTS)} each name an issue and take either its uuid or the display key ` +
  `this tool answers with under issueId (ISS-42 under the shared prefix, whatever prefix the ` +
  `project holds otherwise, or that key's bare sequence number); a key resolves inside the ` +
  `project the call is scoped to, and one that resolves to nothing is refused by name rather ` +
  `than read as absent. ${byField(TASK_REF_INPUTS)} names a TASK and takes its uuid alone.`;

/** Shape refusals are the resolver's: only it knows the project a key was looked for in. */
export const issueRefSchema = z.string().trim().min(1).describe(ISSUE_REF_CLAUSE);

const uuidSchema = z.uuid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

function registered(inputs: readonly RefInput[], action: string, field: string): boolean {
  return inputs.some((i) => i.action === action && i.field === field);
}

/** One call's references, bound to its action and scope. */
export interface CallRefs {
  issue(field: string, ref: string): Promise<string>;
  task(field: string, ref: string): string;
}

/** Scope is deferred and memoised, so a uuid costs no lookup and two keys cost one. Membership is
 *  asserted BEFORE a key is read: resolving first answers whether an issue exists in a project the
 *  caller cannot see. */
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
