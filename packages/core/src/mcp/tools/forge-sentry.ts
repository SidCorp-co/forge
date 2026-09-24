/**
 * `forge_sentry` — the door an agent asks what the product it is building is erroring on.
 *
 * Read-only by construction: two actions, both reads, and the adapter's status-write call is not
 * imported here. A tool that can resolve a Sentry issue is a tool that can hide a live defect, and
 * that wants its own argument rather than a flag on this one.
 *
 * The refusals are values, not sentences: `ok: false` with a `refusal.reason` a caller switches on,
 * because "no binding" and "the credential was rejected" send whoever met them somewhere different
 * and an answer that cannot be told apart from an empty error stream is worse than none.
 */

import { z } from 'zod';
import {
  readProjectSentryIssue,
  readProjectSentryIssues,
  SENTRY_AGENT_STATUSES,
  type SentryAgentListRequest,
} from '../../integrations/sentry/agent-read.js';
import { SENTRY_LIST_MAX_LIMIT } from '../../integrations/sentry/listing.js';
import { isSentryRefusal } from '../../integrations/sentry/refusals.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  type McpContext,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['list', 'get']),
    projectId: z.uuid().optional(),
    /** Which declared Sentry target to read; required where the binding declares more than one. */
    target: z.string().min(1).max(200).optional(),
    /** get: the Sentry issue id or short id, exactly as `list` returned it. */
    issueId: z.string().min(1).max(200).optional(),
    status: z.enum(SENTRY_AGENT_STATUSES).optional(),
    release: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(500).optional(),
    method: z.string().min(1).max(20).optional(),
    errorCode: z.string().min(1).max(200).optional(),
    requestId: z.string().min(1).max(200).optional(),
    /** A relative window Sentry takes: `1h`, `24h`, `7d`. Rejected outside that shape. */
    window: z.string().min(1).max(20).optional(),
    query: z.string().min(1).max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(SENTRY_LIST_MAX_LIMIT).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const forgeSentryTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_sentry',
  description:
    "Read this project's Sentry error stream. Actions: list | get. " +
    'READ-ONLY: it reads Sentry and changes nothing there — no resolving, ignoring or assigning — ' +
    'and it files nothing in the Forge tracker. That is the scheduled `sentry_pull` intake, which ' +
    'is a different question and is not this tool. ' +
    'MODEL: the credential is the Sentry connection Forge holds, never yours — core resolves the ' +
    "project's binding and makes the Sentry call itself, so there is no token to fetch, none is " +
    'returned, and nothing here accepts a Sentry host, organization or token from you. ' +
    'NO THRESHOLDS: the intake exists to decide what is worth FILING and applies minimum event and ' +
    'user counts; a read does not, so the error nobody has seen twice yet is answered like any ' +
    'other. ' +
    'list: { ok:true, target, organizationSlug, projectSlug, query, window, issues[], confinedOut[],' +
    ' pages, truncated }. Each issue is { id, shortId, title, culprit, metadataValue, level, ' +
    'status, substatus, count, userCount, firstSeen, lastSeen, permalink, projectSlug }. `query` is ' +
    'the search Sentry was actually asked, so a surprising answer can be read back to its question. ' +
    '`truncated:true` means Sentry still had more and this adapter stopped at its own page bound, ' +
    'so the reading is a floor. `confinedOut` names answers that belong to another Sentry project ' +
    'under the same organization — they are reported, never dropped in silence. ' +
    'Filters, all optional and all ANDed: `release` (core tags every event with the source commit, ' +
    'so this is how you ask whether the commit you just deployed is erroring), `window` (a relative ' +
    'Sentry period — 1h, 24h, 7d, up to 90d; a value Sentry does not take is REFUSED, never ' +
    'silently replaced by the default), `path`, `method`, `errorCode` and `requestId` (the ' +
    'http.path, http.method, error.code and request.id tags core sets on every captured event), ' +
    '`status` (unresolved by default; `any` drops the status term), `limit` (1..100) and `query` ' +
    'for raw Sentry search syntax, which is ADDED to the filters rather than replacing them. ' +
    'get: one issue in the same shape, for an `issueId` list returned. An id belonging to another ' +
    'project under the same organization is refused and its detail is NOT in the answer. ' +
    'REFUSALS: a call that could not read Sentry answers { ok:false, refusal:{ reason, message, ' +
    'bindingId, httpStatus } } and carries NO `issues` key — an empty `issues` array only ever ' +
    'means Sentry returned no issues. Switch on `reason`, never on the wording: no_binding, ' +
    'binding_disabled, connection_disabled, not_granted (an org owner or admin turns agent access ' +
    'on under Settings → Integrations), no_credential, credential_rejected, scope_missing, ' +
    'sentry_http_error, sentry_unreachable, no_targets, target_ambiguous (the binding declares ' +
    'several — pass `target`, the message lists them), target_unknown, target_no_org, confined_out, ' +
    'bad_argument. ' +
    'Project scope comes from the X-Forge-Project-Slug header (or an explicit projectId). ' +
    'Authorization: project membership, plus the binding granted to agents.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    try {
      return { ok: true, ...(await dispatchAction(input, ctx)) };
    } catch (err) {
      if (isSentryRefusal(err)) {
        return {
          ok: false,
          refusal: {
            reason: err.reason,
            message: err.message,
            bindingId: err.bindingId,
            httpStatus: err.httpStatus,
          },
        };
      }
      throw err;
    }
  },
});

async function dispatchAction(input: Input, ctx: McpContext): Promise<Record<string, unknown>> {
  // The call's own shape first: a `get` naming nothing to get is malformed whichever project it
  // was aimed at, and refusing it here names what is missing without looking anything up.
  if (input.action === 'get' && !input.issueId) {
    throw new Error(
      'BAD_REQUEST: get needs `issueId` — the Sentry issue id or short id `list` gave',
    );
  }
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  await assertPrincipalIsMember(ctx.principal, projectId);

  if (input.action === 'get') {
    const issue = await readProjectSentryIssue({
      projectId,
      issueId: input.issueId as string,
      ...(input.target ? { target: input.target } : {}),
    });
    return { issue };
  }

  return { ...(await readProjectSentryIssues(listRequest(input, projectId))) };
}

/**
 * The filters the caller actually passed, as a listing request.
 *
 * Built key by key rather than spread: `exactOptionalPropertyTypes` tells an absent filter from one
 * explicitly set to undefined, and a spread of the parsed input carries the second.
 */
function listRequest(input: Input, projectId: string): SentryAgentListRequest {
  const keys = [
    'target',
    'status',
    'release',
    'path',
    'method',
    'errorCode',
    'requestId',
    'window',
    'query',
    'limit',
  ] as const;
  const request: SentryAgentListRequest = { projectId };
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined) Object.assign(request, { [key]: value });
  }
  return request;
}
