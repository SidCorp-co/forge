/**
 * The record half of the comment screen: the field budget, and the lead.
 *
 * `screen.ts` judges a message's TEXT, one segment at a time, and knows nothing
 * of records. This judges the parse — which field is over its budget and by how
 * much — and then hands the one field that is prose, the `lead`, back to that
 * same screen as a segment of its own (ISS-1089).
 */

import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { organizationMembers, projects, users } from '../db/schema.js';
import { ROLE_PRODUCT, ROLE_TECHNICAL } from './audiences.js';
import type { Audience, MessageRefusal, MessageVerdict } from './contract.js';
import {
  FORGE_RECORD_FIELD_BUDGET,
  type ForgeRecord,
  type ForgeRecordField,
} from './forge-record.js';
import { screenMessage } from './screen.js';

/** The rules this module owns, for the document that has to name them all. */
export const RECORD_RULE_IDS: readonly string[] = ['field-budget'];

const SHAPE = `every field of a \`forge-record\` block is at most ${FORGE_RECORD_FIELD_BUDGET} characters`;
const EXAMPLE = 'finding: holds';

/**
 * A field past its budget, told to whoever wrote it by name and by how much.
 */
// cm:guard the refusal names the KEY and the overage, and both halves are load-bearing. A message
// saying only "too long" makes a writer trim whichever field is cheapest to cut, which is how the
// wall moves rather than goes — the whole reason the unit is the field and there is no cap on the
// record as a whole (ISS-1089).
function refusalFor(field: ForgeRecordField): MessageRefusal {
  return {
    rule: 'field-budget',
    why: `the \`${field.key}\` field is ${field.over} character(s) over its ${FORGE_RECORD_FIELD_BUDGET}-character budget — a field that has outgrown its job is not trimmed at random: say less, or move what belongs elsewhere to the field that holds it`,
    quote: field.key,
    shape: SHAPE,
    example: EXAMPLE,
  };
}

/** Every field of this record that is past the budget, in the order written. */
export function budgetRefusals(record: ForgeRecord | null): MessageRefusal[] {
  if (!record) return [];
  return record.fields.filter((f) => f.over > 0).map(refusalFor);
}

/**
 * Which reading the lead is screened under, for one project.
 */
// cm:guard the question asked here is about HUMAN members only, and `users.kind` is what answers it.
// An organization's agent users hold rows in `organization_members` too, and an agent carrying a
// `technical` lens would otherwise decide how a record is written for the people reading it — which
// is the fleet choosing its own audience (ISS-1089).
// cm:guard it fails to `role:product`, never open. An empty `lenses` array already means product
// everywhere else it is read (`prompt/system.ts:buildChatRoleSection` folds no-lens and explicit
// `product` into one branch), so a project with no lens set, no org, or a read that threw is read
// by the stricter of the two cells rather than by the looser one.
export async function projectLeadAudience(projectId: string, executor?: Tx): Promise<Audience> {
  const handle = executor ?? db;
  try {
    const [project] = await handle
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project?.orgId) return ROLE_PRODUCT;
    const rows = await handle
      .select({ lenses: organizationMembers.lenses })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, project.orgId), eq(users.kind, 'human')));
    const technical = rows.some((r) => ((r.lenses ?? []) as string[]).includes('technical'));
    return technical ? ROLE_TECHNICAL : ROLE_PRODUCT;
  } catch {
    return ROLE_PRODUCT;
  }
}

/**
 * The lead, screened alone, against the cell the project's lens names.
 */
// cm:guard this is a SECOND `screenMessage` call over one segment and not a widening of the first:
// the whole-body `role:report` screen runs unchanged, with its four rules in their order, because
// the voice rules are about one sentence and reading them over a whole comment would refuse the
// file paths and fenced evidence a record is supposed to carry.
export function screenLead(lead: string, audience: Audience): MessageVerdict {
  return screenMessage({ audience, intent: 'report', segments: [lead] });
}

/**
 * Everything the record itself is refused for: the budget, then the lead.
 */
// cm:guard a record carrying no `lead` is screened for its budget and NOTHING else, which is the
// parse reporting absence rather than inventing a lead: `forge-record` contract 1 has no such
// field, so synthesising one from `detail` would show a writer a refusal about a sentence it never
// wrote. `lead` and `beside` are requested on forge-plugin and land there, not here.
export async function recordRefusals(
  projectId: string,
  record: ForgeRecord | null,
  executor?: Tx,
): Promise<MessageRefusal[]> {
  if (!record) return [];
  const refusals = budgetRefusals(record);
  if (record.lead === null) return refusals;
  const verdict = screenLead(record.lead, await projectLeadAudience(projectId, executor));
  return verdict.ok ? refusals : [...refusals, ...verdict.refusals];
}
