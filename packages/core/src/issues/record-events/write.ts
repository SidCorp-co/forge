// The one door every caller-authored record event passes: REST and MCP both write through it, so a
// record is screened the same way whoever sends it (ISS-56).

import { db, type Tx } from '../../db/client.js';
import { MessageRefusedError } from '../../messaging/contract.js';
import { recordRefusals } from '../../messaging/record-screen.js';
import {
  assertRecordEventDraft,
  type RecordEvent,
  recordOfFields,
  type WriteRecordEventInput,
  writeRecordEvent,
} from './store.js';

export interface ScreenedRecordEventInput extends Omit<WriteRecordEventInput, 'commentId' | 'at'> {
  readonly projectId: string;
}

/**
 * Check the draft's shape (EVENT_KIND_UNKNOWN / EVENT_PAYLOAD_INVALID), then screen it as the
 * comment door screens an agent's record — field budget, verdict identity, design, evidence and
 * lead — and store it only if nothing refused it.
 */
export async function writeScreenedRecordEvent(
  input: ScreenedRecordEventInput,
  executor: Tx = db,
): Promise<RecordEvent> {
  assertRecordEventDraft(input);
  const record = recordOfFields(input.kind, input.contract, input.fields);
  const refusals = await recordRefusals(input.projectId, record, executor);
  if (refusals.length > 0) throw new MessageRefusedError('record-event-write', refusals);
  const { projectId: _project, ...write } = input;
  return writeRecordEvent(write, executor);
}
