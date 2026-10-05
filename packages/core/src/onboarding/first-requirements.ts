/**
 * Workflow project-onboarding steps `req-case` to `req-result`: once every onboarding design is
 * approved, the BA assistant gets one case room to draft the first requirements from the approved
 * journeys, each a requirement_draft suggestion on the journey design it serves.
 *
 * The room IS the case's record: its venue id is derived from the onboarding, so opening it twice
 * finds the first. The case opens with a Forge line and a window of origin `onboarding_handoff` over
 * it, so the BA drafts without waiting for a message; that turn acts for the onboarding's starter
 * with nothing but the suggestion acts (`assistant/turn-origin.ts`). The BA asks what the journeys
 * leave open through the onboarding questionnaire card, due and flagged unanswered by the same rule.
 */

import type { OnboardingFirstRequirements } from '@forge/contracts/onboarding';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import {
  addPerson,
  appendMessagesIn,
  findConversation,
  openConversationIn,
  openOrExtendWindow,
  settleShape,
  type TxOnly,
} from '../conversations/index.js';
import { db } from '../db/client.js';
import { conversationMessages } from '../db/schema-conversations.js';
import { onboardings, questionnaireBatches } from '../db/schema-onboarding.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { lockXact } from '../lib/advisory-lock.js';
import { consume } from '../outbox/index.js';
import { announce } from '../questionnaires/index.js';
import { designsOf, type OnboardingRow, onboardingOf, openBatchView } from './read.js';

const VENUE_PREFIX = 'first-requirements:';

export const firstRequirementsVenue = (onboardingId: string) => `${VENUE_PREFIX}${onboardingId}`;

/** The onboarding a case room's venue names, or null for any other room. */
export function firstRequirementsOnboardingOf(
  externalId: string | null | undefined,
): string | null {
  return externalId?.startsWith(VENUE_PREFIX) ? externalId.slice(VENUE_PREFIX.length) : null;
}

/** Step `onboarded`: the case is owed once the onboarding drafted designs and every one is approved. */
export function firstRequirementsCaseOwed(
  designs: readonly { designStatus: string | null }[],
): boolean {
  return designs.length > 0 && designs.every((d) => d.designStatus === 'approved');
}

/** Step `req-result`; `pending` while the case is open and the BA has neither suggested nor answered. */
export type FirstRequirementsStatus = OnboardingFirstRequirements['status'];

export type FirstRequirementsResult = OnboardingFirstRequirements;

export function firstRequirementsStatusOf(facts: {
  suggested: number;
  baAnswered: boolean;
}): FirstRequirementsStatus {
  if (facts.suggested > 0) return 'suggested';
  return facts.baAnswered ? 'none' : 'pending';
}

/** The project's first-requirements outcome, or null while no case is open. */
export async function readFirstRequirements(
  projectId: string,
  now = new Date(),
): Promise<FirstRequirementsResult | null> {
  const row = await onboardingOf(db, projectId);
  if (!row) return null;
  const room = await findConversation('web', firstRequirementsVenue(row.id));
  if (!room) return null;
  const [[drafts], [answers]] = await Promise.all([
    row.designs.length
      ? db
          .select({ n: count() })
          .from(suggestions)
          .where(
            and(
              eq(suggestions.kind, 'requirement_draft'),
              inArray(suggestions.workflowId, row.designs),
              inArray(suggestions.status, ['proposed', 'accepted']),
            ),
          )
      : Promise.resolve([{ n: 0 }]),
    db
      .select({ n: count() })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, room.id),
          eq(conversationMessages.role, 'assistant'),
          ne(conversationMessages.content, ''),
        ),
      ),
  ]);
  const suggested = Number(drafts?.n ?? 0);
  return {
    status: firstRequirementsStatusOf({ suggested, baAnswered: Number(answers?.n ?? 0) > 0 }),
    conversationId: room.id,
    suggested,
    openBatch: await openBatchView(db, eq(questionnaireBatches.firstRequirementsOf, row.id), now),
  };
}

interface JourneyStep {
  id: string;
  label: string | null;
  does: string | null;
}

/** What the BA drafts from: each onboarding design, its steps, and the drafts already on it. */
export interface FirstRequirementsJourney {
  workflowId: string;
  flow: string;
  title: string;
  designStatus: string | null;
  approvedRevision: number | null;
  steps: JourneyStep[];
  drafts: { id: string; status: string }[];
}

function stepsOf(document: unknown): JourneyStep[] {
  const steps = (document as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((s: { id?: unknown; does?: unknown; node?: { label?: unknown } }) =>
    typeof s?.id === 'string'
      ? [
          {
            id: s.id,
            label: typeof s.node?.label === 'string' ? s.node.label : null,
            does: typeof s.does === 'string' ? s.does.slice(0, 2_000) : null,
          },
        ]
      : [],
  );
}

export async function firstRequirementsJourneys(
  projectId: string,
): Promise<FirstRequirementsJourney[]> {
  const row = await onboardingOf(db, projectId);
  if (!row || row.designs.length === 0) return [];
  const [designs, documents, drafts] = await Promise.all([
    designsOf(db, projectId, row.designs),
    db
      .select({ id: projectWorkflows.id, document: projectWorkflows.document })
      .from(projectWorkflows)
      .where(
        and(eq(projectWorkflows.projectId, projectId), inArray(projectWorkflows.id, row.designs)),
      ),
    db
      .select({
        id: suggestions.id,
        status: suggestions.status,
        workflowId: suggestions.workflowId,
      })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.kind, 'requirement_draft'),
          inArray(suggestions.workflowId, row.designs),
        ),
      ),
  ]);
  const docOf = new Map(documents.map((d) => [d.id, d.document]));
  return designs.map((d) => ({
    workflowId: d.workflowId,
    flow: d.flow,
    title: d.title,
    designStatus: d.designStatus,
    approvedRevision: d.approvedRevision,
    steps: stepsOf(docOf.get(d.workflowId)),
    drafts: drafts
      .filter((s) => s.workflowId === d.workflowId)
      .map((s) => ({ id: s.id, status: s.status })),
  }));
}

function caseBrief(designs: readonly { flow: string; title: string }[]): string {
  const named = designs.map((d) => `${d.title} (${d.flow})`).join(', ');
  return `Every onboarding design is approved: ${named}. The BA assistant now drafts the first requirements from these journeys, one suggestion per journey with its business criteria, and may ask what they leave open; you accept or reject each.`;
}

async function openCaseIn(tx: TxOnly, row: OnboardingRow, brief: string): Promise<string | null> {
  const handle = tx as unknown as typeof db;
  await lockXact(tx, 'onboarding', firstRequirementsVenue(row.id));
  const venue = firstRequirementsVenue(row.id);
  if (await findConversation('web', venue, handle)) return null;
  const room = await openConversationIn(handle, {
    adapter: 'web',
    externalId: venue,
    shape: 'direct',
    projectId: row.projectId,
    title: 'First requirements · BA assistant',
  });
  await addPerson({
    conversationId: room.id,
    userId: row.startedBy,
    actorUserId: row.startedBy,
    tx: handle,
  });
  await settleShape(handle, room.id);
  const [line] = await appendMessagesIn(tx, {
    conversationId: room.id,
    messages: [{ role: 'system', content: brief, authorLabel: 'Forge' }],
  });
  if (!line) throw new Error(`first-requirements: the hand-off line in ${room.id} returned no row`);
  await openOrExtendWindow(
    {
      conversationId: room.id,
      projectId: row.projectId,
      adapter: 'web',
      seq: line.seq,
      origin: 'onboarding_handoff',
    },
    handle,
  );
  return room.id;
}

/** Whom a hand-off turn in this onboarding's case room acts for: its starter, or null once it is gone. */
export async function firstRequirementsStarterOf(onboardingId: string): Promise<string | null> {
  const [row] = await db
    .select({ startedBy: onboardings.startedBy })
    .from(onboardings)
    .where(eq(onboardings.id, onboardingId))
    .limit(1);
  return row?.startedBy ?? null;
}

/** Step `req-case`: the case room, opened once per onboarding when it reads onboarded. */
export async function openFirstRequirementsCase(projectId: string): Promise<string | null> {
  const row = await onboardingOf(db, projectId);
  if (!row) return null;
  const designs = await designsOf(db, projectId, row.designs);
  if (!firstRequirementsCaseOwed(designs)) return null;
  const opened = await db.transaction((tx) => openCaseIn(tx, row, caseBrief(designs)));
  if (opened) await announce(opened, null, 'system');
  return opened;
}

/** An approve that leaves the project's onboarding onboarded opens its case; any other decision does not. */
export function registerFirstRequirementsCase(): void {
  consume('workflow.designDecided', {
    name: 'first-requirements',
    handle: async (p) => {
      if (p.decision !== 'approve') return;
      await openFirstRequirementsCase(p.projectId);
    },
  });
}
