/**
 * Who acts for an agent that reported an item (REQ-66 BC-8, ISS-880). An agent has no bell, so the
 * master of the project it reported from is asked to confirm its shipped fix (`owed-verify.ts`), and
 * the doors that read and settle the item admit that master as they admit its reporter. The project is
 * read by the rule the owed line lists the item by (`owed-verify.ts:agentReportedFrom`); the master is
 * an agent's credential that writes that project (`permissions/master-acts.ts:isMasterCredential`). A
 * person, an agent of another project, or an item a person reported admits nobody here.
 */

import { isMasterCredential, permissionFactsOf } from '../permissions/index.js';
import { agentReportedFrom } from './owed-verify.js';
import type { FeedbackActor } from './read.js';

/** The project `actor` is the master of and acts for the item's agent reporter in, or null where it is not. */
export async function reporterMasterProject(
  feedbackId: string,
  actor: FeedbackActor,
): Promise<string | null> {
  if (actor.agency !== 'agent') return null;
  const from = await agentReportedFrom(feedbackId);
  if (!from) return null;
  return isMasterCredential(await permissionFactsOf(actor.userId, from), actor.agency)
    ? from
    : null;
}
