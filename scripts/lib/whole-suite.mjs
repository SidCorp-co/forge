import { ciBranches } from './base-branch.mjs';

/**
 * The whole suite (REQ-36 BC-10, BC-11; Issue to release r20 `rule-suite`): every job of ci.yml
 * run on one commit with the change filter not consulted, nightly and on the commit a release cut
 * names. The one proposition a cut reads is the `whole-suite` check run on that commit: ci.yml's
 * aggregate job, which concludes success only when every job of its run succeeded.
 *
 * Pure over what GitHub recorded. The reader that asks GitHub, and the git history, are the
 * caller's (`scripts/whole-suite.mjs`), so a test plants a record and watches the answer change.
 */

/** The check run ci.yml's aggregate job leaves on the commit its whole-suite run tested. */
export const WHOLE_SUITE_CHECK = 'whole-suite';

/** The jobs that judge or report on the suite rather than being part of it. */
export const SUITE_REPORTERS = ['whole-suite', 'suite-bisect', 'nightly-fanout', 'ci-passed'];

/** The refusal a cut answers with when its commit has no green whole-suite run. */
export const REFUSAL = 'RELEASE_SUITE_NOT_GREEN';

/** How far back the first-parent history is searched for the last green whole-suite run. */
export const HISTORY_LIMIT = 100;

const EVENTS_THAT_RUN_THE_SUITE = new Set(['schedule', 'workflow_dispatch']);

const short = (sha) => String(sha).slice(0, 9);

/** The newest check run of one name an Actions workflow left, or null. */
function newest(checkRuns, name) {
  return (
    checkRuns
      .filter((c) => c.name === name && (c.app?.slug ?? 'github-actions') === 'github-actions')
      .sort((a, b) => b.id - a.id)[0] ?? null
  );
}

/** The workflow run id a check run's page names (`…/actions/runs/<id>/job/<id>`), or null. */
export function runIdOf(htmlUrl) {
  const m = /\/actions\/runs\/(\d+)\//.exec(String(htmlUrl ?? ''));
  return m ? Number(m[1]) : null;
}

/** The run's page, from a check run's job page. */
function runUrlOf(htmlUrl) {
  const m = /^(.*\/actions\/runs\/\d+)\//.exec(String(htmlUrl ?? ''));
  return m ? m[1] : (htmlUrl ?? null);
}

/** The jobs of a run that did not succeed, by name, the reporters left out. */
export function failingJobs(jobs) {
  return jobs
    .filter((j) => !SUITE_REPORTERS.includes(j.name))
    .filter((j) => j.conclusion !== 'success')
    .map((j) => `${j.name} (${j.conclusion ?? j.status ?? 'unknown'})`);
}

/**
 * Where the whole suite stands on one commit: `green`, `red`, `running` or `none`.
 *
 * `reader.checkRuns(sha)` answers every check run on the commit, `reader.runs(sha)` the CI
 * workflow's runs whose head is the commit, and `reader.jobs(runId)` one run's jobs. A run on a
 * schedule or a dispatch still in flight reads `running` whether or not it is a whole-suite run:
 * it is told apart only once its jobs finish, and starting another beside it doubles the cost of
 * a question one run answers.
 */
export function suiteState(reader, sha) {
  const check = newest(reader.checkRuns(sha), WHOLE_SUITE_CHECK);
  if (check && check.status === 'completed') {
    const url = runUrlOf(check.html_url);
    if (check.conclusion === 'success') return { state: 'green', sha, url };
    const runId = runIdOf(check.html_url);
    const failing = runId === null ? [] : failingJobs(reader.jobs(runId));
    return { state: 'red', sha, url, conclusion: check.conclusion, failing };
  }
  if (check) return { state: 'running', sha, url: runUrlOf(check.html_url) };
  const inFlight = reader
    .runs(sha)
    .filter((r) => EVENTS_THAT_RUN_THE_SUITE.has(r.event) && r.status !== 'completed')
    .sort((a, b) => b.id - a.id)[0];
  if (inFlight) return { state: 'running', sha, url: inFlight.html_url };
  return { state: 'none', sha };
}

/** The command that starts the whole suite on a branch's head, for a person to run by hand. */
export function dispatchCommand(branch) {
  return `gh workflow run ci.yml --ref ${branch} -f base=${branch} -f suite=whole`;
}

/**
 * What a cut on `sha` is told. `ok` lets the cut proceed; otherwise `sentence` refuses it by name,
 * and `dispatch` says the cut should start the whole suite on its commit (nothing has, and nothing
 * is running).
 */
export function gateVerdict(status) {
  const at = short(status.sha);
  switch (status.state) {
    case 'green':
      return { ok: true, sentence: `whole suite green on ${at}: ${status.url}` };
    case 'running':
      return {
        ok: false,
        dispatch: false,
        sentence: `${REFUSAL}: a CI run is still running on ${at} (${status.url}). Cut again once it has finished; if it was not a whole-suite run, that cut starts one.`,
      };
    case 'red':
      return {
        ok: false,
        dispatch: false,
        sentence: `${REFUSAL}: the whole suite is red on ${at} (${status.url}): ${status.failing.length > 0 ? status.failing.join(', ') : `concluded ${status.conclusion}`}. Its suite-bisect job names the merge that broke it. Land the fix, then cut on the commit that carries it.`,
      };
    default:
      return {
        ok: false,
        dispatch: true,
        sentence: `${REFUSAL}: ${at} has no whole-suite run, so nothing says every suite passes on what this cut would ship.`,
      };
  }
}

/** The last green whole-suite run among `ancestors` (newest first), or null within the limit. */
export function lastGreen(reader, ancestors) {
  for (const sha of ancestors.slice(0, HISTORY_LIMIT)) {
    if (newest(reader.checkRuns(sha), WHOLE_SUITE_CHECK)?.conclusion === 'success') return sha;
  }
  return null;
}

/**
 * The tracker keys a landing names: its own subject's (a branch merged as `iss-471` counts), else
 * the subjects it merged in. More than one key is every one of them, never a pick.
 */
export function issuesOf(subject, mergedSubjects = []) {
  const keys = (text) =>
    [...String(text ?? '').matchAll(/\bISS-(\d+)\b/gi)].map((m) => `ISS-${m[1]}`);
  const own = keys(subject);
  const found = own.length > 0 ? own : mergedSubjects.flatMap(keys);
  return [...new Set(found)];
}

/**
 * What one commit's records say about the failing jobs. `good`: a green whole-suite run, or every
 * failing job recorded as succeeding there. `bad`: a red whole-suite run, or one failing job
 * recorded as failing there. Null where nothing recorded says either. A check of another name
 * (a merge check that ran a selection) is not read: it may not have run the test now failing,
 * which is the red a passed merge check missed.
 */
export function evidenceOf(checkRuns, failingNames) {
  const whole = newest(checkRuns, WHOLE_SUITE_CHECK);
  if (whole?.status === 'completed') return whole.conclusion === 'success' ? 'good' : 'bad';
  const latest = failingNames.map((name) => newest(checkRuns, name));
  if (
    latest.some((c) => c?.status === 'completed' && ['failure', 'timed_out'].includes(c.conclusion))
  ) {
    return 'bad';
  }
  const allPassed =
    latest.length > 0 &&
    latest.every((c) => c?.status === 'completed' && c.conclusion === 'success');
  return allPassed ? 'good' : null;
}

/**
 * Bisects `landings` (oldest first, the red commit last) by what CI recorded on each.
 *
 * The broken merge lies after the last landing recorded good and at or before the first landing
 * after it recorded bad; the red commit is bad by definition. A failure recorded before the last
 * good one was fixed since, so it is not this red. One landing between them is named; more than
 * one is the range, named in full, because no record separates them.
 */
export function bisect(landings, evidence) {
  const marks = landings.map((l) => evidence(l.sha));
  marks[marks.length - 1] = 'bad';
  const good = marks.lastIndexOf('good');
  const bad = marks.indexOf('bad', good + 1);
  const suspects = landings.slice(good + 1, bad + 1);
  return suspects.length === 1 ? { named: suspects[0] } : { range: suspects };
}

function landingLine(l) {
  const issues = l.issues ?? [];
  return `${short(l.sha)} ${l.subject} (${issues.length > 0 ? issues.join(', ') : 'names no issue'})`;
}

/** The sentence a red whole-suite run leaves, naming the merge or the range. */
export function bisectReport({ red, failing, green, result, searched }) {
  const head = `The whole suite went red on ${short(red)}: ${failing.length > 0 ? failing.join(', ') : 'no failing job was read'}.`;
  const since = green
    ? `Last green whole-suite run: ${short(green)}.`
    : `No green whole-suite run in the last ${searched} first-parent commits, so the range runs from the oldest of them.`;
  if (result.named) {
    return `${head}\n${since}\nThe merge that broke it: ${landingLine(result.named)}.`;
  }
  return [
    head,
    since,
    `No single merge is named: nothing recorded between them separates these ${result.range.length}. The merge that broke it is one of:`,
    ...result.range.map((l) => `- ${landingLine(l)}`),
  ].join('\n');
}

/** Every gated branch but the one a scheduled run already ran on, from ci.yml's own trigger. */
export function fanoutTargets(ciText, ranOn) {
  const branches = ciBranches(ciText).push;
  if (branches === null) return null;
  return branches.filter((b) => b !== ranOn);
}
