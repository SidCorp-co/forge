import type { criterionVerdicts } from '../../db/schema-issue-criteria.js';
import type { Actor } from '../../pipeline/activity.js';
import type { RecordEventField } from '../record-events/store.js';
import type { VerdictAuthor } from './store.js';
import type { VerdictDraft } from './verdict-input.js';

export type VerdictColumns = Partial<typeof criterionVerdicts.$inferInsert>;

export function verdictActor(author: VerdictAuthor): Actor {
  if (author.deviceId) return { type: 'device', id: author.deviceId, agency: author.agency };
  if (author.userId) return { type: 'user', id: author.userId, agency: author.agency };
  throw new Error('a verdict names its author: an account or a device, and this one names neither');
}

const IDENTITY_FIELDS: ReadonlyArray<readonly [keyof VerdictColumns, string]> = [
  ['identityKind', 'identity'],
  ['commitSha', 'commit'],
  ['runtimeRef', 'runtime'],
  ['designWorkflowId', 'design-workflow'],
  ['designRevision', 'design-revision'],
  ['contractRef', 'contract'],
  ['contractVersion', 'contract-version'],
  ['storefrontWorkflowId', 'storefront-workflow'],
  ['storefrontDraftVersion', 'draft-version'],
  ['storefrontEnvironment', 'environment'],
  ['corroboration', 'corroboration'],
];

export function verdictRecordFields(args: {
  id: string;
  draft: VerdictDraft;
  identity: VerdictColumns;
}): RecordEventField[] {
  const { id, draft, identity } = args;
  const fields: RecordEventField[] = [
    { key: 'verdict-id', value: id },
    { key: 'criterion', value: String(draft.criterion) },
    { key: 'verdict', value: draft.verdict },
  ];
  for (const [column, key] of IDENTITY_FIELDS) {
    const value = identity[column];
    if (value !== undefined && value !== null) fields.push({ key, value: String(value) });
  }
  const reason = draft.reason?.trim();
  if (reason) fields.push({ key: 'why', value: reason });
  for (const cited of draft.evidence) fields.push({ key: 'evidence', value: cited });
  return fields;
}
