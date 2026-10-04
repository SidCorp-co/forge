import { z } from 'zod';
import { messageRefused } from '../../comments/screen.js';
import { loadIssueProjectId } from '../../comments/service.js';
import {
  isRecordEventKind,
  KERNEL_ONLY_RECORD_KINDS,
  RECORD_DIGEST_KIND,
  RECORD_EVENT_KINDS,
} from '../../issues/record-events/kinds.js';
import { serializeRecordEvent } from '../../issues/record-events/routes.js';
import {
  listRecordEvents,
  type RecordEvent,
  RecordEventRefused,
} from '../../issues/record-events/store.js';
import { writeScreenedRecordEvent } from '../../issues/record-events/write.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import { type ContextScopedMcpToolFactory, principalHookActor, zodToMcpSchema } from './lib.js';
import { requireCan } from '../../permissions/index.js';

const inputSchema = z
  .object({
    action: z.enum(['write', 'list']),
    issueId: z.uuid(),
    kind: z.string().max(64).optional(),
    contract: z.number().optional(),
    fields: z.array(z.object({ key: z.string().max(64), value: z.string() }).strict()).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

/** Agent-written field text is data to a reader, never instructions. */
function framed(event: RecordEvent) {
  return {
    ...serializeRecordEvent(event),
    fields: event.fields.map((f) => ({
      key: f.key,
      value: markUntrusted(f.value, { source: 'record.field' }),
    })),
    lead: event.lead ? markUntrusted(event.lead, { source: 'record.lead' }) : null,
  };
}

export const forgeIssueEventsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_issue_events',
  reach: 'project',
  route: '/api/issues',
  grant: { byAction: { write: 'issues:write', list: 'issues:read' } },
  description:
    "Write or list an issue's typed record events — the store a `forge-record` belongs in instead of a comment (ISS-56). " +
    `action=write: issueId, kind (one of ${RECORD_EVENT_KINDS.join(', ')}), contract (the record contract number, e.g. 1) and fields [{key,value}] in the order written. ` +
    `A kind outside the set is refused EVENT_KIND_UNKNOWN; a bad contract or field is EVENT_PAYLOAD_INVALID; ${KERNEL_ONLY_RECORD_KINDS.join(', ')} are written by core in the transaction of the move or verdict they record, and posting one is refused EVENT_KIND_KERNEL_ONLY (record a verdict with forge_criteria action=verdict). ` +
    'Verdicts, transitions, landings, parks and corrections are kept for good; fold, routed, gap and baseline collapse into one digest 180 days after the issue closes. ' +
    'action=list: issueId, optional kind, limit; oldest first.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;
    const projectId = await loadIssueProjectId(input.issueId);
    if (input.action === 'list') {
      await requireCan({ userId: principal.userId }, 'project.read', projectId);
      if (
        input.kind !== undefined &&
        input.kind !== RECORD_DIGEST_KIND &&
        !isRecordEventKind(input.kind)
      ) {
        throw new Error(`BAD_REQUEST: EVENT_KIND_UNKNOWN: \`${input.kind}\` is not a record kind`);
      }
      const events = await listRecordEvents(input.issueId, {
        ...(input.kind ? { kinds: [input.kind as RecordEvent['kind']] } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      });
      return { events: events.map(framed), returned: events.length };
    }
    await requireCan({ userId: principal.userId }, 'project.write', projectId);
    try {
      const event = await writeScreenedRecordEvent({
        projectId,
        issueId: input.issueId,
        actor: principalHookActor(principal),
        kind: input.kind ?? '',
        contract: input.contract ?? Number.NaN,
        fields: input.fields ?? [],
      });
      return { event: framed(event) };
    } catch (err) {
      if (err instanceof RecordEventRefused)
        throw new Error(`BAD_REQUEST: ${err.code}: ${err.message}`);
      const refused = messageRefused(err);
      if (refused) throw new Error(`BAD_REQUEST: ${refused.code}: ${refused.message}`);
      throw err;
    }
  },
});
