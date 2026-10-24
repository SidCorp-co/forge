import { createHash } from 'node:crypto';
import { contentLanguageName } from '@forge/contracts/content-language';
import type { MasterWork } from '@forge/contracts/master-verdict';
import type { AnswerResume } from '@forge/contracts/questions';
import {
  RELEASE_NAME_WORDS_MAX,
  RELEASE_NOTE_TITLE_WORDS_MAX,
} from '@forge/contracts/release-notes';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { readAdmissibleIssues, readOwedComments } from '../devices/index.js';
import { type GuideSlug, guideCall } from '../guides/index.js';
import { mastersPorts, type ReleaseMergeOwed, type StewardAsk } from './ports.js';

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
  /** Releases drafted, or cut and not yet out, that carry no name and summary, where the master names them. */
  unnamedReleases: { version: string }[];
  /** Accepted change-request releases waiting on their next merge, which only the master makes (REQ-71 BC-4). */
  releaseMerges: ReleaseMergeOwed[];
  /** Running releases the project requires approval for, with no request asked (ISS-591). */
  releaseApprovals: { runId: string; version: string | null }[];
  /** Park questions answered since the master's last finished pass began, with what each did. */
  answers: { issueKey: string; questionId: string; outcome: AnswerResume | null }[];
  /** What the steward asked the master to act on, each standing until its item's standing moves. */
  stewardAsks: StewardAsk[];
  /** `in_progress` issues the wedge pass left because their work landed, owed their move to `awaiting_release` (ISS-564). */
  landedWork: { issueId: string; key: string; commit: string | null; mergedAt: string }[];
  /** The project's content language tag, which a release note is written in. */
  contentLanguage: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A line names the guide that holds its method by slug, never restates it (REQ-23 BC-2). */
const method = (slug: GuideSlug) => `\`${guideCall(slug)}\``;

function returnedLine(owed: Owed): string {
  let line = '';
  const { designs, revisions } = owed;
  if (designs.length > 0) {
    const keys = designs.map((d) => `${d.flow} r${d.revision}, workflow ${d.workflowId}`);
    line += ` ${designs.length} returned design${plural(designs.length, ' owes', 's owe')} a revision no issue carries (${keys.join('; ')}): read each return's reason (\`forge-runner api projects/<projectId>/workflows/<workflowId>/design\`), then get the next revision written and proposed in a declared run, or record why it waits; ${method('workflow-design')} is how a revision is written and proposed, and the forge-master skill's returned-work section is the master's part.`;
  }
  if (revisions.length > 0) {
    const keys = revisions.map((r) => `${r.key} r${r.revision}`);
    line += ` ${revisions.length} returned requirement revision${plural(revisions.length, ' owes', 's owe')} a revise (${keys.join(', ')}): read each (\`forge-runner api projects/<projectId>/requirements/<key>\`, its revision's \`returnReason\`), then write and propose it again, or drop it; ${method('requirement-lifecycle')} is how, and the forge-master skill's returned-work section is the master's part.`;
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

/**
 * The door that records a decision on an item of each kind, as the nudge names it (ISS-654): an
 * issue's `decision` record, or the decision comment a feedback item or a requirement takes. The
 * issue door answers 404 for any other kind, so each ask names the door of its own item.
 */
const DECISION_DOOR: Record<StewardAsk['subject']['kind'], (keys: string) => string> = {
  issue: (keys) =>
    `on an issue (${keys}), \`forge-runner api issues/<id>/events -X POST\` with \`kind: decision\` and the fields \`decision\` and \`why\`, plus \`until\` only as an ISO 8601 date such as 2026-11-01`,
  feedback: (keys) =>
    `on a feedback item (${keys}), \`forge-runner api projects/<projectId>/feedback/<key>/comments -X POST\` with \`intent: decision\` and \`decision: { decision, reason }\`, plus \`reversedWhen\` only as an ISO 8601 date such as 2026-11-01`,
  requirement: (keys) =>
    `on a requirement (${keys}), \`forge-runner api projects/<projectId>/requirements/<key>/comments -X POST\` with \`intent: decision\` and \`decision: { decision, reason }\`, plus \`reversedWhen\` only as an ISO 8601 date such as 2026-11-01`,
};

/** REQ-48 BC-5: the durable half of a steward wake, so a wake the box missed is read on its next sweep. */
function stewardAsksLine(asks: Owed['stewardAsks']): string {
  if (asks.length === 0) return '';
  const kinds = (['issue', 'feedback', 'requirement'] as const).flatMap((kind) => {
    const keys = [
      ...new Set(asks.filter((a) => a.subject.kind === kind).map((a) => a.subject.key)),
    ];
    return keys.length > 0 ? [DECISION_DOOR[kind](keys.join(', '))] : [];
  });
  return ` The project's steward asks you to act on ${asks.length} item${plural(asks.length, '', 's')} (${asks.map((a) => a.ask).join('; ')}): read each item's standing (\`forge-runner api projects/<projectId>/standings\`) and take the act it waits on, or record why it waits as a decision on that item, at its own door: ${kinds.join('; ')} (other text there is a condition, held until the standing moves); the ask stands until the item's standing moves or such a decision answers it.`;
}

function answersLine(answers: Owed['answers']): string {
  if (answers.length === 0) return '';
  const keys = answers.map(
    (a) => `${a.issueKey} question ${a.questionId}: ${outcomeOf(a.outcome)}`,
  );
  return ` ${answers.length} park question${plural(answers.length, ' was', 's were')} answered since your last pass (${keys.join('; ')}): an answered question is no longer owed by a person, so read each answer (\`forge-runner api questions/<questionId>\`, or the \`answer\` record on \`forge-runner api issues/<id>/events\`) and act on what it says.`;
}

/** Landed work nothing holds: no status moves by itself, so the master makes the move its run did not. */
function landedWorkLine(landed: Owed['landedWork']): string {
  if (landed.length === 0) return '';
  const keys = landed.map((l) => `${l.key} ${l.issueId}${l.commit ? ` at ${l.commit}` : ''}`);
  return ` ${landed.length} issue${plural(landed.length, ' sits', 's sit')} at \`in_progress\` with ${plural(landed.length, 'its', 'their')} work landed and nothing holding ${plural(landed.length, 'it', 'them')} (${keys.join('; ')}): the reconciler left each there rather than hand it back. Check that the mark is this work, then move it on (\`forge-runner api issues/<id>/transition -X POST -d '{"toStatus":"awaiting_release","reason":"<the commit it landed>"}'\`), as ${method('issue-flow')} (Land, mark, move) says; a mark that is not this work is cleared (\`forge-runner api issues/<id>/merge -X DELETE\`), and the next reconciler pass hands the issue back.`;
}

/** The sentence a nudge or a first brief carries for what is owed besides issues; empty when nothing is. */
export function owedLine(owed: Owed): string {
  let line =
    returnedLine(owed) +
    answersLine(owed.answers) +
    stewardAsksLine(owed.stewardAsks) +
    landedWorkLine(owed.landedWork);
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
    line += ` ${breakdowns.length} agreed requirement${plural(breakdowns.length, ' has', 's have')} no breakdown yet (${keys.join(', ')}): read each (\`forge-runner api projects/<id>/requirements/<key>\`) and propose its breakdown as a suggestion, as ${method('suggestions')} says; an overdue one is past its breakdown SLA. One whose capability already shipped owes no verifying issue: judge each criterion at the requirement instead (\`forge-runner api projects/<id>/requirements/<key>/verdicts -X POST\`).`;
  }
  if (triages.length > 0) {
    line += ` ${triages.length} feedback item${plural(triages.length, ' owes', 's owe')} a triage (${triages.map((t) => t.key).join(', ')}): read each (\`forge-runner api projects/<projectId>/feedback/<key>\`, and \`/similar\` for its nearest), then route it (\`forge-runner api projects/<projectId>/feedback/<key>/triage -X POST\`) or propose a \`feedback_triage\` suggestion (\`forge-runner api projects/<projectId>/suggestions -X POST\`); ${method('feedback-triage')} is how, and the forge-master skill's feedback section is when a master routes and when it proposes.`;
  }
  if (comments.length > 0) {
    // a question is cleared only by a reply threaded under it (devices/comment-inbox.ts), so each
    // is named with the comment id the reply's parentId takes
    const keys = comments.map((c) => `${c.issueKey} comment ${c.commentId}`);
    line += ` A person is owed a reply on ${comments.length} issue${plural(comments.length, '', 's')} (${keys.join(', ')}): read each thread (\`forge-runner api issues/<id>/comments\`), and reply in that comment's thread (\`forge-runner api issues/<id>/comments -X POST\` with \`parentId\` set to the comment id), as ${method('ecosystem-inbox')} (Issue comments) says.`;
  }
  if (documents.length > 0) {
    const numbers = documents.map((d) => d.number ?? d.id);
    line += ` The ecosystem channel owes ${documents.length} repl${plural(documents.length, 'y', 'ies')} (${numbers.join(', ')}): list them (\`forge-runner api projects/<projectId>/channel/unanswered\`), read each (\`forge-runner api projects/<projectId>/channel/documents/<number>\`), and ${method('ecosystem-inbox')} is how to work them.`;
  }
  if (builderRuns.length > 0) {
    line += ` ${builderRuns.length} ecosystem builder run${plural(builderRuns.length, ' is', 's are')} open (${builderRuns.map((r) => r.id).join(', ')}): \`forge-runner api projects/<projectId>/builder-runs\` lists them, and ${method('ecosystem-inbox')} is how to work one.`;
  }
  if (releaseNotes.length > 0) {
    const keys = releaseNotes.map((r) => `${r.key} ${r.issueId}`);
    line += ` ${releaseNotes.length} issue${plural(releaseNotes.length, ' waits', 's wait')} at the release gate with no release note (${keys.join(', ')}), so the next release refuses to carry ${plural(releaseNotes.length, 'it', 'them')} (\`RELEASE_RECORD_MISSING\`): read each issue and what it shipped, then write its note (\`forge-runner api issues/<id> -X PATCH -d '{"releaseNotes":{"section":"Added","title":"<the change's short name, at most ${RELEASE_NOTE_TITLE_WORDS_MAX} words>","userFacing":"<the one plain sentence a user would read, in ${contentLanguageName(contentLanguage)}>"}}'\`), as ${method('issue-flow')} (Land, mark, move) says, its sections, \`adminSteps\` and \`Skip\` included; the project's content language is ${contentLanguageName(contentLanguage)} (\`${contentLanguage}\`), so the note is written in it whatever language the issue or its commits are in.`;
  }
  if (warnedNotes.length > 0) {
    const keys = warnedNotes.map((n) => `${n.key} ${n.issueId} (${n.problems.join('; ')})`);
    line += ` ${warnedNotes.length} release note${plural(warnedNotes.length, '', 's')} at the release gate ${plural(warnedNotes.length, 'reads', 'read')} wrong to a user (${keys.join(', ')}): rewrite each in ${contentLanguageName(contentLanguage)} so the problem named goes (\`forge-runner api issues/<id> -X PATCH -d '{"releaseNotes":{"section":"<the same section>","title":"<its short name, at most ${RELEASE_NOTE_TITLE_WORDS_MAX} words>","userFacing":"<the sentence>"}}'\`), as ${method('issue-flow')} (Land, mark, move) says a note reads, moving the engineering detail to \`technical\`; this is a reader aid, the release is not refused for it.`;
  }
  if (owed.unnamedReleases.length > 0) {
    const versions = owed.unnamedReleases.map((r) => r.version);
    line += ` ${versions.length} release${plural(versions.length, '', 's')} drafted or cut ${plural(versions.length, 'has', 'have')} no name (${versions.join(', ')}), so ${plural(versions.length, 'its page opens', 'their pages open')} on a bare version: read what each carries (\`forge-runner api projects/<projectId>/releases/<version>\`), then name it (\`forge-runner api projects/<projectId>/releases/<version>/naming -X PUT -d '{"name":"<a few words, at most ${RELEASE_NAME_WORDS_MAX}>","summary":"<two or three sentences on what it brings its users, in ${contentLanguageName(contentLanguage)}>"}'\`); a draft's name carries through its cut, and a cut can carry both as \`name\` and \`summary\`.`;
  }
  return line + releasesLine(owed);
}

const releaseName = (r: { runId: string; version: string | null }) =>
  r.version ? `${r.version} (run ${r.runId})` : `run ${r.runId}`;

/** The acts a running release owes the master: its approval request, then its merges in order. */
function releasesLine(owed: Owed): string {
  let line = '';
  const { releaseApprovals, releaseMerges } = owed;
  if (releaseApprovals.length > 0) {
    line += ` ${releaseApprovals.length} running release${plural(releaseApprovals.length, ' waits', 's wait')} for an approval request, which this project requires before any production act (${releaseApprovals.map(releaseName).join(', ')}): ask for each with \`forge-runner api projects/<projectId>/release-batches/<runId>/approvals -X POST -d '{"evidence":{"environment":"<where the reading was taken, omitted on a release that merges change requests>","commit":"<the full sha read>","reading":"<what was read there>"}}'\`, and a project admin accepts or returns it.`;
  }
  if (releaseMerges.length > 0) {
    const steps = releaseMerges.map(
      (m) =>
        `${releaseName(m)}: ${m.next.label} next, ${m.merged} of ${m.total} merged, through ${m.next.issueKey} ${m.next.issueId}`,
    );
    line += ` ${releaseMerges.length} accepted release${plural(releaseMerges.length, ' waits', 's wait')} for you to merge its requests in their declared order (${steps.join('; ')}): merge each next one with \`forge-runner api issues/<issueId>/merge-pull-request -X POST -d '{"pullRequest":<number>}'\`, one at a time; the release ends at its last merge, and where its owner deploys nothing is deployed for it. A refusal names its fault: \`RELEASE_MERGE_HEAD_MOVED\` means the request's head moved since the owner accepted it, so abort the release and cut it again on the new head.`;
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
    ...owed.stewardAsks.map((a) => `steward-ask:${a.actId}`),
    ...owed.landedWork.map((l) => `landed-work:${l.issueId}|${l.mergedAt}`),
    ...owed.documents.map((d) => `document:${d.id}`),
    ...owed.builderRuns.map((r) => `builder-run:${r.id}`),
    // the gate's identity: the reason and the issue it names, so a note owed reads the same every sweep
    ...owed.releaseNotes.map((r) => `release-note:${r.issueId}`),
    ...owed.warnedNotes.map((n) => `warned-note:${n.issueId}|${n.problems.join(';')}`),
    // the next merge, so each merge made moves the digest and the master is asked for the one after
    ...owed.releaseMerges.map((m) => `release-merge:${m.runId}|${m.next.number}`),
    ...owed.releaseApprovals.map((r) => `release-approval:${r.runId}`),
  ];
  return [...issues, ...ids].sort();
}

/** A digest of the work, compared for equality only: the same work digests the same on every sweep. */
export function workDigest(admissible: Admissible[], owed: Owed): string {
  const hash = createHash('sha256');
  for (const line of workLines(admissible, owed)) hash.update(`${line}\n`);
  return hash.digest('hex').slice(0, 32);
}

/**
 * REQ-13 BC-1: what the master writes onto this project's records is in its content language, not
 * the language this nudge is written in; said on every nudge where that language is not English.
 */
export function contentLanguageLine(tag: string): string {
  if (tag.toLowerCase().split('-')[0] === 'en') return '';
  const name = contentLanguageName(tag);
  return ` Write everything you put on this project's records in ${name} (\`${tag}\`): comments and replies, decision records, questions to a person, triage text, suggestions, plans and release notes, and the briefs you give a run so its records are too. Code, identifiers, commit messages and branch names stay English.`;
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
    nudge: `${NUDGE}${line}${contentLanguageLine(owed.contentLanguage)}`,
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
    unnamedReleases,
    contentLanguage,
    stewardAsks,
    releaseMerges,
    releaseApprovals,
    landedWork,
  ] = await Promise.all([
    readAdmissibleIssues({ deviceId, projectId }),
    readOwedComments(projectId),
    ports.channelOwed(projectId),
    ports.breakdownsOwed(projectId),
    ports.revisionsOwed(projectId),
    ports.triagesOwed(projectId),
    ports.designsOwed(projectId),
    ports.releaseNotesOwed(projectId),
    releasesTheMasterNames(projectId),
    ports.contentLanguageOf(projectId),
    ports.stewardAsks(projectId),
    ports.releaseMergesOwed(projectId),
    ports.releaseApprovalsOwed(projectId),
    ports.landedWorkOwed(projectId),
  ]);
  const held = new Set(await ports.breakdownsHeldBySteward(projectId));
  const breakdownsDue = breakdowns.filter((b) => !held.has(b.key));
  const warnedNotes = await ports.releaseNotesWarned(projectId, contentLanguage);
  const lastPass = await lastFinishedPassStart(projectId);
  const answers = lastPass ? await ports.answersSince(projectId, lastPass) : [];
  return masterWork(admissible.items, {
    designs,
    revisions,
    breakdowns: breakdownsDue,
    triages,
    comments: comments.items,
    documents: channel.documents,
    builderRuns: channel.builderRuns,
    releaseNotes,
    warnedNotes,
    unnamedReleases,
    releaseMerges,
    releaseApprovals,
    answers,
    stewardAsks,
    landedWork,
    contentLanguage,
  });
}

/**
 * The unnamed releases the master is asked to name: none where naming goes to somebody else (ISS-590).
 * Naming takes project.admin, which a master acting as a member is refused, so asking it would ask
 * every pass for a write it can never make; the release's page names its admins instead.
 */
async function releasesTheMasterNames(projectId: string): Promise<{ version: string }[]> {
  const ports = mastersPorts();
  const unnamed = await ports.releasesUnnamed(projectId);
  if (unnamed.length === 0) return unnamed;
  return (await ports.releaseNamer(projectId)).to === 'master' ? unnamed : [];
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
