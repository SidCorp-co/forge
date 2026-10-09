/**
 * The merge check's record half (Issue to release r20 `rule-merge`; REQ-36 BC-9, BC-15, BC-17;
 * ISS-472). A project's own check runs the code half — on this repository `scripts/merge-check.mjs`:
 * the typecheck, the direct tests of the touched files, their direct integration tests and the
 * conformance gate, on the change rebased onto the latest base — and sends its report here. Core
 * refuses a report a merge may not rely on, asks the issue's approved new patterns for their catalog
 * pages in the change, and records a passing check on the issue with every check's command, files and
 * duration. The merge mark then asks for that record (`uncheckedMergeRefusal`).
 *
 * The report is the box's word, as a mark without an observed commit is: core cannot rerun the
 * checks, so the record says what the box ran and when, and is written by core only after core's own
 * rules held.
 */

import type { MergeCheckRefusalCode, MergeCheckReport } from '@forge/contracts/merge-check';
import { db } from '../db/client.js';
import { refuser } from '../lib/refusal.js';
import type { Actor } from './activity.js';
import { issueDisplayIds } from './display-ids.js';
import {
  type CheckOwedBy,
  checkRefusal,
  headMatches,
  missingCheckDetail,
  passingHeads,
  recordFields,
} from './merge-check-rules.js';
import { hasApprovedNewPattern, patternEntryRefusal } from './pattern-entry.js';
import { readProjectDocument } from './ports.js';
import { listRecordEvents, type RecordEvent, writeCoreRecord } from './record-events/store.js';

const refuse = refuser<MergeCheckRefusalCode>('MERGE_CHECK_REFUSED');

/** Record a passing merge check on the issue, or refuse the report by the name of what failed. */
export async function recordMergeCheck(args: {
  issue: { id: string; projectId: string };
  report: MergeCheckReport;
  actor: Actor;
}): Promise<RecordEvent> {
  const { issue, report } = args;
  const fault = checkRefusal(report);
  if (fault) throw refuse(fault.code, fault.detail, fault.path);
  const entry = await patternEntryRefusal({
    issueId: issue.id,
    projectId: issue.projectId,
    paths: { commit: report.head, changes: report.touched },
  });
  if (entry) throw refuse(entry.code, entry.detail, entry.path);
  return writeCoreRecord(db, {
    issueId: issue.id,
    actor: args.actor,
    kind: 'verification',
    fields: recordFields(report),
  });
}

/** What makes this mark owe a merge check, or null where nothing does. */
async function checkOwedBy(issueId: string, projectId: string): Promise<CheckOwedBy | null> {
  const document = (await readProjectDocument(projectId))?.document;
  if (document?.validation?.mergeCheck === 'required') return 'project';
  return (await hasApprovedNewPattern(issueId)) ? 'pattern' : null;
}

/**
 * The merge mark's refusal where a merge check is owed and none passed at the commit marked, or
 * null. A check is owed where the project declares `validation.mergeCheck: required`, or where the
 * issue introduces an approved new pattern, whose catalog page only the check asks for. A merge the
 * source host's webhook records is not asked: it has already happened, and its CI gated it.
 */
export async function uncheckedMergeRefusal(args: {
  issueId: string;
  projectId: string;
  commit: string | null;
}): Promise<string | null> {
  const owedBy = await checkOwedBy(args.issueId, args.projectId);
  if (!owedBy) return null;
  const records = await listRecordEvents(args.issueId, {
    kinds: ['verification'],
    kernelOnly: true,
  });
  const heads = passingHeads(records);
  if (args.commit && headMatches(heads, args.commit)) return null;
  const issueRef = (await issueDisplayIds([args.issueId])).get(args.issueId) ?? args.issueId;
  return missingCheckDetail({ issueRef, owedBy, commit: args.commit, heads });
}
