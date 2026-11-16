// The checks the steward's lessons pass files (REQ-50 r2 BC-6, ISS-1167): each lesson owed a check
// is filed by what its record says it is about. An app lesson becomes an "Add a check" draft in the
// project's backlog; a process lesson, about a Forge step no code in the project can catch, is routed
// once to Forge as its feedback. One whose record does not say is classified first
// (`lessons-classify.ts`). The pass itself is `lessons-pass.ts`.

import { type LessonAbout, lessonKey } from '@forge/contracts/lessons';
import { cutAtWord } from '@forge/contracts/title-text';
import { fileForgeFeedback } from '../feedback/index.js';
import { createIssue } from '../issues/index.js';
import {
  checksOwed,
  classifyLesson,
  type OwedCheck,
  recordCheckIssue,
  recordRoutedFeedback,
} from '../lessons/index.js';
import { logger } from '../lib/logger.js';
import { findProjectSlugs } from '../projects/index.js';
import type { Classifier } from './lessons-classify.js';

const CHECK_TITLE_CHARS = 120;

function checkBody(owed: OwedCheck): string {
  return [
    `${lessonKey(owed.number)} keeps being corrected${owed.repeats > 0 ? `, ${owed.repeats} time(s) after it was approved` : ''}: "${owed.sentence}"`,
    'Turn it into a check in code so it is caught before a person sees it: a lint rule, a test, or a screen probe.',
    'The corrections it learned from:',
    ...owed.reasons.map((r) => `- ${r}`),
  ].join('\n\n');
}

/**
 * Each lesson owed a check (BC-6), by what its record says it is about (ISS-1167), never its scope: an
 * app lesson keeps its "Add a check" draft in the project's backlog, one routed to Forge before it
 * was classified included; a process lesson, about an agent's judgement or a Forge step no code in the
 * project's repo can catch, is routed once to Forge as its feedback, naming the step. One whose record
 * does not say is classified by the steward from its corrections first, and filed neither way until
 * it is: it waits for the next pass, counted `unclassified`.
 */
export async function fileChecks(
  projectId: string,
  stewardId: string,
  classify: Classifier,
  tally: { checks: number; unclassified: number },
): Promise<void> {
  for (const owed of await checksOwed(projectId)) {
    const about = owed.about ?? (await classified(projectId, stewardId, classify, owed));
    if (!about) {
      tally.unclassified += 1;
      continue;
    }
    if (about === 'process') {
      if (!owed.routed && (await routeToForge(projectId, stewardId, owed))) tally.checks += 1;
      continue;
    }
    const made = await createIssue(
      {
        projectId,
        title: cutAtWord(`Add a check: ${owed.sentence}`, CHECK_TITLE_CHARS),
        description: checkBody(owed),
        priority: 'medium',
        status: 'draft',
        detectorKey: `lesson-check/${owed.id}`,
      },
      {
        createdById: stewardId,
        createdByDeviceId: null,
        createdVia: 'system',
        actor: { type: 'user', id: stewardId, agency: 'agent' },
      },
    );
    const issueId = made.deduped ? made.existingIssueId : made.issue.id;
    await recordCheckIssue(owed.id, issueId);
    tally.checks += 1;
  }
}

/** The steward's classification of a lesson its record does not say, written once; null while it gives none. */
async function classified(
  projectId: string,
  stewardId: string,
  classify: Classifier,
  owed: OwedCheck,
): Promise<LessonAbout | null> {
  const answer = await classify(projectId, owed);
  if (!answer) {
    logger.warn(
      { projectId, lesson: lessonKey(owed.number) },
      'steward: a lesson owed a check is owed its classification first; it is asked again next pass',
    );
    return null;
  }
  const wrote = await classifyLesson({
    projectId,
    ref: owed.id,
    actor: { userId: stewardId, agency: 'agent' },
    about: answer.about,
  });
  // classified meanwhile by another hand: the next pass reads what its record now says
  return wrote ? answer.about : null;
}

/** The Forge step a process lesson names: the kind of agent output it is scoped to, else the project's agents. */
const stepOf = (owed: OwedCheck) =>
  owed.output ? `the agent step that produces a ${owed.output}` : "the project's agents' judgement";

/** Routes a process lesson to Forge's own feedback, once; a refusal (no Forge home) is logged and retried next pass. */
async function routeToForge(
  projectId: string,
  stewardId: string,
  owed: OwedCheck,
): Promise<boolean> {
  // Forge's feedback is read beside every project's lessons, so the lesson is named with its own
  // project: a bare L-n there reads as Forge's L-n, another lesson (ISS-1222, FB-624)
  const slug = (await findProjectSlugs([projectId])).get(projectId) ?? projectId;
  const named = `${slug} ${lessonKey(owed.number)}`;
  const filed = await fileForgeFeedback({
    actor: { userId: stewardId, agency: 'agent' },
    request: {
      kind: 'change_request',
      title: cutAtWord(`A Forge step keeps being corrected: ${owed.sentence}`, CHECK_TITLE_CHARS),
      whereSeen: stepOf(owed),
      body: [
        `${named} is about ${stepOf(owed)}, which no check in the project's code can catch: the Forge step that makes this judgement should make it right. Read it at GET /api/projects/${projectId}/knowledge/lesson-${owed.number}.`,
        'The corrections it learned from:',
        ...owed.reasons.map((r) => `- ${r}`),
      ].join('\n\n'),
      signalKey: `lesson-process/${owed.id}`,
    },
    source: { projectId, issueId: null, runId: null, clientVersion: null },
  });
  if (!filed.ok) {
    logger.warn(
      { projectId, lesson: lessonKey(owed.number), refusals: filed.refusals.map((r) => r.code) },
      'steward: a process lesson was not routed to Forge; it is tried again next pass',
    );
    return false;
  }
  await recordRoutedFeedback(owed.id, filed.id);
  return true;
}
