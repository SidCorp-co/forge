import { createHash } from 'node:crypto';
import { contentLanguageName } from '@forge/contracts/content-language';
import type { MasterWork } from '@forge/contracts/master-verdict';
import type { AnswerResume } from '@forge/contracts/questions';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { readAdmissibleIssues, readOwedComments } from '../devices/index.js';
import { mastersPorts } from './ports.js';

/** The edge kind that gates dispatch, the one whose blocker's state changes what a master can take. */
const GATING_KIND = 'blocks';

const NUDGE =
  'Pass. Hand it to the dispatch skill, and say what you dispatched and why you did not dispatch the rest.';

type Admissible = Awaited<ReturnType<typeof readAdmissibleIssues>>['items'][number];

/** Everything a project's master is owed besides its admissible issues, as one read. */
interface Owed {
  designs: { workflowId: string; flow: string; revision: number }[];
  revisions: { key: string; revision: number }[];
  breakdowns: { key: string; overdue: boolean }[];
  triages: { key: string }[];
  comments: { issueKey: string; commentId: string }[];
  documents: { id: string; number: string | null }[];
  builderRuns: { id: string; ecosystem: string }[];
  releaseNotes: { issueId: string; key: string }[];
  /** Notes written but not in the content language, or carrying an engineer's reference. */
  warnedNotes: { issueId: string; key: string; problems: string[] }[];
  /** Park questions answered since the master's last finished pass began, with what each did. */
  answers: { issueKey: string; questionId: string; outcome: AnswerResume | null }[];
  /** The project's content language tag, which a release note is written in. */
  contentLanguage: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function returnedLine(owed: Owed): string {
  let line = '';
  const { designs, revisions } = owed;
  if (designs.length > 0) {
    const keys = designs.map((d) => `${d.flow} r${d.revision}, workflow ${d.workflowId}`);
    line += ` ${designs.length} returned design${plural(designs.length, ' owes', 's owe')} a revision no issue carries (${keys.join('; ')}): read each return's reason (\`forge-runner api projects/<projectId>/workflows/<workflowId>/design\`), then get the next revision written and proposed in a declared run, or record why it waits; the forge-master skill's returned-work section is the method.`;
  }
  if (revisions.length > 0) {
    const keys = revisions.map((r) => `${r.key} r${r.revision}`);
    line += ` ${revisions.length} returned requirement revision${plural(revisions.length, ' owes', 's owe')} a revise (${keys.join(', ')}): read each (\`forge-runner api projects/<projectId>/requirements/<key>\`, its revision's \`returnReason\`), then write and propose it again, or drop it; the forge-master skill's returned-work section is the method.`;
  }
  return line;
}

/** What an answer did to the park it stopped, as the nudge says it. */
function outcomeOf(outcome: AnswerResume | null): string {
  if (!outcome) return 'not acted on yet';
  switch (outcome.kind) {
    case 'resumed':
      return `moved back to \`${outcome.to}\``;
    case 'sent_to_run':
      return 'sent to the run that asked';
    case 'box_reads':
      return 'read back by the box that asked';
    case 'other_question':
      return `still parked: another question is open (${outcome.questionIds.join(', ')})`;
    case 'held':
      return 'still parked: the answer says the issue still waits';
    case 'no_left_status':
      return 'still parked: the park recorded no status to return to, so it is moved by hand';
    case 'staged':
      return 'still parked: this project stages answers, so it is moved by hand';
    case 'refused':
      return `still parked: the move back was refused ${outcome.code}`;
  }
}

function answersLine(answers: Owed['answers']): string {
  if (answers.length === 0) return '';
  const keys = answers.map(
    (a) => `${a.issueKey} question ${a.questionId}: ${outcomeOf(a.outcome)}`,
  );
  return ` ${answers.length} park question${plural(answers.length, ' was', 's were')} answered since your last pass (${keys.join('; ')}): an answered question is no longer owed by a person, so read each answer (\`forge-runner api questions/<questionId>\`, or the \`answer\` record on \`forge-runner api issues/<id>/events\`) and act on what it says.`;
}

/** The sentence a nudge or a first brief carries for what is owed besides issues; empty when nothing is. */
export function owedLine(owed: Owed): string {
  let line = returnedLine(owed) + answersLine(owed.answers);
  const {
    breakdowns,
    triages,
    comments,
    documents,
    builderRuns,
    releaseNotes,
    warnedNotes,
    contentLanguage,
  } = owed;
  if (breakdowns.length > 0) {
    const keys = breakdowns.map((b) => (b.overdue ? `${b.key} overdue` : b.key));
    line += ` ${breakdowns.length} agreed requirement${plural(breakdowns.length, ' has', 's have')} no breakdown yet (${keys.join(', ')}): read each (\`forge-runner api projects/<id>/requirements/<key>\`) and propose its breakdown as a suggestion; an overdue one is past its breakdown SLA.`;
  }
  if (triages.length > 0) {
    line += ` ${triages.length} feedback item${plural(triages.length, ' owes', 's owe')} a triage (${triages.map((t) => t.key).join(', ')}): read each (\`forge-runner api projects/<projectId>/feedback/<key>\`, and \`/similar\` for its nearest), then route it (\`forge-runner api projects/<projectId>/feedback/<key>/triage -X POST\`) or propose a \`feedback_triage\` suggestion (\`forge-runner api projects/<projectId>/suggestions -X POST\`); the forge-master skill's feedback section is the method.`;
  }
  if (comments.length > 0) {
    // a question is cleared only by a reply threaded under it (devices/comment-inbox.ts), so each
    // is named with the comment id the reply's parentId takes
    const keys = comments.map((c) => `${c.issueKey} comment ${c.commentId}`);
    line += ` A person is owed a reply on ${comments.length} issue${plural(comments.length, '', 's')} (${keys.join(', ')}): read each thread (\`forge-runner api issues/<id>/comments\`), reply to that comment in its thread (\`forge-runner api issues/<id>/comments -X POST\` with \`parentId\` set to the comment id), and move the issue when the comment asks for it; only a threaded reply clears it, a top-level comment does not.`;
  }
  if (documents.length > 0) {
    const numbers = documents.map((d) => d.number ?? d.id);
    line += ` The ecosystem channel owes ${documents.length} repl${plural(documents.length, 'y', 'ies')} (${numbers.join(', ')}): list them (\`forge-runner api projects/<projectId>/channel/unanswered\`), read each (\`forge-runner api projects/<projectId>/channel/documents/<number>\`), and \`forge-runner api guides/ecosystem-inbox.md\` is how to work them.`;
  }
  if (builderRuns.length > 0) {
    line += ` ${builderRuns.length} ecosystem builder run${plural(builderRuns.length, ' is', 's are')} open (${builderRuns.map((r) => r.id).join(', ')}): \`forge-runner api projects/<projectId>/builder-runs\` lists them, and \`forge-runner api guides/ecosystem-inbox.md\` is how to work one.`;
  }
  if (releaseNotes.length > 0) {
    const keys = releaseNotes.map((r) => `${r.key} ${r.issueId}`);
    line += ` ${releaseNotes.length} issue${plural(releaseNotes.length, ' waits', 's wait')} at the release gate with no release note (${keys.join(', ')}), so the next release refuses to carry ${plural(releaseNotes.length, 'it', 'them')} (\`RELEASE_RECORD_MISSING\`): read each issue and what it shipped, then write its note (\`forge-runner api issues/<id> -X PATCH -d '{"releaseNotes":{"section":"Added","userFacing":"<the one plain line a user would read, in ${contentLanguageName(contentLanguage)}>"}}'\`; the project's content language is ${contentLanguageName(contentLanguage)} (\`${contentLanguage}\`), so the line is written in it whatever language the issue or its commits are in, section one of Added, Changed, Fixed, Removed, Security, or \`{"section":"Skip","userFacing":"-"}\` when the change has no user-facing half).`;
  }
  if (warnedNotes.length > 0) {
    const keys = warnedNotes.map((n) => `${n.key} ${n.issueId} (${n.problems.join('; ')})`);
    line += ` ${warnedNotes.length} release note${plural(warnedNotes.length, '', 's')} at the release gate ${plural(warnedNotes.length, 'reads', 'read')} wrong to a user (${keys.join(', ')}): rewrite each as the one plain line a user would read, in ${contentLanguageName(contentLanguage)}, with no commit sha, issue key or rule code in it (\`forge-runner api issues/<id> -X PATCH -d '{"releaseNotes":{"section":"<the same section>","userFacing":"<the line>"}}'\`), keeping the engineering detail in \`technical\`; this is a reader aid, the release is not refused for it.`;
  }
  return line;
}

function count(owed: Owed): number {
  const { contentLanguage: _language, ...lists } = owed;
  return Object.values(lists).reduce((n, items) => n + items.length, 0);
}

/** One line per thing a master is owed, so the digest moves exactly when the work does. */
function workLines(admissible: Admissible[], owed: Owed): string[] {
  const issues = admissible.map((a) => {
    const gates = a.relations
      .filter((r) => r.kind === GATING_KIND)
      .map((r) => `${r.dependsOnKey ?? ''}|${r.blockerStatus ?? ''}`)
      .sort();
    return `issue:${a.issueId}|${a.status}|${gates.join(';')}`;
  });
  const ids = [
    ...owed.designs.map((d) => `design:${d.workflowId}#r${d.revision}`),
    ...owed.revisions.map((r) => `revision:${r.key}#r${r.revision}`),
    ...owed.breakdowns.map((b) => `breakdown:${b.key}`),
    ...owed.triages.map((t) => `triage:${t.key}`),
    ...owed.comments.map((c) => `comment:${c.commentId}`),
    ...owed.answers.map((a) => `answer:${a.questionId}|${a.outcome?.kind ?? ''}`),
    ...owed.documents.map((d) => `document:${d.id}`),
    ...owed.builderRuns.map((r) => `builder-run:${r.id}`),
    // the gate's identity: the reason and the issue it names, so a note owed reads the same every sweep
    ...owed.releaseNotes.map((r) => `release-note:${r.issueId}`),
    ...owed.warnedNotes.map((n) => `warned-note:${n.issueId}|${n.problems.join(';')}`),
  ];
  return [...issues, ...ids].sort();
}

/** A digest of the work, compared for equality only: the same work digests the same on every sweep. */
export function workDigest(admissible: Admissible[], owed: Owed): string {
  const hash = createHash('sha256');
  for (const line of workLines(admissible, owed)) hash.update(`${line}\n`);
  return hash.digest('hex').slice(0, 32);
}

/** The work a project's master is owed, composed into what a pass is asked about. */
export function masterWork(admissible: Admissible[], owed: Owed): MasterWork {
  const owedCount = count(owed);
  const line = owedLine(owed);
  const only = admissible.length === 1 && owedCount === 0 ? admissible[0] : undefined;
  return {
    admissible: admissible.length,
    owed: owedCount,
    digest: workDigest(admissible, owed),
    nudge: `${NUDGE}${line}`,
    owedLine: line,
    issueKey: only?.issueKey ?? null,
  };
}

/**
 * Everything a project's master on `deviceId` is owed this sweep: the issues it could open a wave
 * over, and the channel, threads, requirements, feedback, returned designs and release notes that owe it a turn.
 * A read that fails fails the verdict, which the box says and acts on nothing: none is skipped.
 */
export async function readMasterWork(deviceId: string, projectId: string): Promise<MasterWork> {
  const ports = mastersPorts();
  const [
    admissible,
    comments,
    channel,
    breakdowns,
    revisions,
    triages,
    designs,
    releaseNotes,
    contentLanguage,
  ] = await Promise.all([
    readAdmissibleIssues({ deviceId, projectId }),
    readOwedComments(projectId),
    ports.channelOwed(projectId),
    ports.breakdownsOwed(projectId),
    ports.revisionsOwed(projectId),
    ports.triagesOwed(projectId),
    ports.designsOwed(projectId),
    ports.releaseNotesOwed(projectId),
    ports.contentLanguageOf(projectId),
  ]);
  const warnedNotes = await ports.releaseNotesWarned(projectId, contentLanguage);
  const lastPass = await lastFinishedPassStart(projectId);
  const answers = lastPass ? await ports.answersSince(projectId, lastPass) : [];
  return masterWork(admissible.items, {
    designs,
    revisions,
    breakdowns,
    triages,
    comments: comments.items,
    documents: channel.documents,
    builderRuns: channel.builderRuns,
    releaseNotes,
    warnedNotes,
    answers,
    contentLanguage,
  });
}

/**
 * When the project's last finished master pass began: an answer after it was not in front of that
 * pass, and is named until a pass that began after it has ended. A project whose master never
 * finished a pass has nothing to measure "since" against, so its first pass reads the board whole.
 */
async function lastFinishedPassStart(projectId: string): Promise<Date | null> {
  const rows = (await db.execute(sql`
    SELECT max(started_at) AS started_at FROM master_passes
     WHERE project_id = ${projectId} AND ended_at IS NOT NULL
  `)) as unknown as Array<{ started_at: string | Date | null }>;
  const at = rows[0]?.started_at;
  return at ? new Date(at) : null;
}
