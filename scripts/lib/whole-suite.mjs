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

/** How many first-parent landings back the bisect looks for the last green whole-suite run. */
export const HISTORY_LIMIT = 100;

/** One top-level job's block of a workflow, up to the next job, or null. */
function jobBlock(ciText, id) {
  const text = String(ciText ?? '');
  const at = text.indexOf(`\n  ${id}:\n`);
  if (at === -1) return null;
  const rest = text.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/**
 * The jobs of ci.yml a whole-suite run does not judge, by job id: every job its `whole-suite` job
 * does not need. That is the reporters and `merge-check`, dev's merge path, which every whole-suite
 * run skips by design (ISS-472); a skip there says nothing about the suite, so it is never a reason
 * the suite went red and never a job to bisect (ISS-471's judge, comment 49f4b0cd). Null where the
 * jobs or the aggregate's `needs` cannot be read: a caller refuses rather than reading every job.
 */
export function unjudgedJobs(ciText) {
  const text = String(ciText ?? '');
  const jobsAt = text.indexOf('\njobs:\n');
  const aggregate = jobBlock(text, WHOLE_SUITE_CHECK);
  const needs = aggregate && /^ {4}needs:\s*\[([^\]]*)\]/m.exec(aggregate);
  if (jobsAt === -1 || !needs) return null;
  const ids = [...text.slice(jobsAt).matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]);
  const judged = new Set(
    needs[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return new Set(ids.filter((id) => !judged.has(id)));
}

/**
 * The job id a job of a run carries: its name, less the matrix values GitHub appends
 * (`runner-platforms (windows-latest)` is `runner-platforms`). ci.yml gives no job a `name:` of its
 * own, so the name is the id; one that did would read as judged, and be named, never dropped.
 */
const jobIdOf = (name) => String(name).replace(/ \(.*\)$/, '');

const judged = (unjudged) => (j) => !unjudged.has(jobIdOf(j.name));

const EVENTS_THAT_RUN_THE_SUITE = new Set(['schedule', 'workflow_dispatch']);

const short = (sha) => String(sha).slice(0, 9);

/**
 * A check run that says nothing: the job's `if:` was false, so it never ran. Every run that is not
 * a whole-suite run (a push, a pull request, a dispatch without `suite: whole`) leaves the
 * `whole-suite` job concluded so on its commit, as every path-filtered job is on a run its filter
 * did not select (main ebbf3c813, runs 37860396822 and 37854612040).
 */
const ranNothing = (c) => c.status === 'completed' && c.conclusion === 'skipped';

/** The newest check run of one name an Actions workflow left that records a run, or null. */
function newest(checkRuns, name) {
  return (
    checkRuns
      .filter((c) => c.name === name && (c.app?.slug ?? 'github-actions') === 'github-actions')
      .filter((c) => !ranNothing(c))
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

/**
 * The reasons a whole-suite run went red: each job it judges that did not succeed, a skipped one
 * included (a whole suite that skipped a job did not run the whole suite), with its conclusion.
 * `unjudged` is `unjudgedJobs(ci.yml)`.
 */
export function failingJobs(jobs, unjudged) {
  return jobs
    .filter(judged(unjudged))
    .filter((j) => j.conclusion !== 'success')
    .map((j) => `${j.name} (${j.conclusion ?? j.status ?? 'unknown'})`);
}

/**
 * The conclusions that say a job's own steps failed: a test, a build or a check said no, or ran
 * past its limit. Every other way not to succeed (`cancelled`, `skipped`, a runner that never
 * started) says nothing about the code, and the way out of it is a rerun, not a fix.
 */
const FAILED_ON_ITS_OWN = new Set(['failure', 'timed_out']);

/**
 * The jobs a red whole-suite run is bisected on, by name: each one it judges that failed on its own
 * steps. A cancelled or skipped job recorded nothing about the code, so no landing can be told good
 * or bad by it.
 */
export function brokenJobs(jobs, unjudged) {
  return jobs
    .filter(judged(unjudged))
    .filter((j) => FAILED_ON_ITS_OWN.has(j.conclusion))
    .map((j) => j.name);
}

/** Whether any job of the suite failed on its own steps, rather than being cancelled or skipped. */
export function failedOnATest(jobs, unjudged) {
  return brokenJobs(jobs, unjudged).length > 0;
}

/**
 * Where the whole suite stands on one commit: `green`, `red`, `running` or `none`.
 *
 * `reader.checkRuns(sha)` answers every check run on the commit, `reader.runs(sha)` the CI
 * workflow's runs whose head is the commit, and `reader.jobs(runId)` one run's jobs. A green
 * whole-suite check answers at once. Otherwise a run on a schedule or a dispatch still in flight
 * reads `running`, whether or not it is a whole-suite run and whether or not an older one was red:
 * it is told apart only once its jobs finish (a rerun of a red one keeps its run id, and its new
 * whole-suite check appears only when every job it waits on has), and starting another beside it
 * doubles the cost of a question one run answers. A red run's reasons are the jobs it judges
 * (`unjudged` is `unjudgedJobs(ci.yml)`).
 */
export function suiteState(reader, sha, unjudged) {
  const check = newest(reader.checkRuns(sha), WHOLE_SUITE_CHECK);
  if (check?.conclusion === 'success') {
    return { state: 'green', sha, url: runUrlOf(check.html_url) };
  }
  if (check && check.status !== 'completed') {
    return { state: 'running', sha, url: runUrlOf(check.html_url) };
  }
  const inFlight = reader
    .runs(sha)
    .filter((r) => EVENTS_THAT_RUN_THE_SUITE.has(r.event) && r.status !== 'completed')
    .sort((a, b) => b.id - a.id)[0];
  if (inFlight) return { state: 'running', sha, url: inFlight.html_url };
  if (!check) return { state: 'none', sha };
  const runId = runIdOf(check.html_url);
  const jobs = runId === null ? [] : reader.jobs(runId);
  return {
    state: 'red',
    sha,
    url: runUrlOf(check.html_url),
    runId,
    checkId: check.id,
    conclusion: check.conclusion,
    failing: failingJobs(jobs, unjudged),
    onATest: failedOnATest(jobs, unjudged),
  };
}

/** The command that starts the whole suite on a branch's head, for a person to run by hand. */
export function dispatchCommand(branch) {
  return `gh workflow run ci.yml --ref ${branch} -f base=${branch} -f suite=whole`;
}

/** The command that reruns a run's jobs that did not succeed, for a person to run by hand. */
export function rerunCommand(runId) {
  return `gh run rerun ${runId} --failed`;
}

/**
 * What a cut on `sha` is told. `ok` lets the cut proceed; otherwise `sentence` refuses it by name.
 * `dispatch` says the cut may start the whole suite on its commit (nothing has, and nothing is
 * running); `wait` that a run on it is still to finish; `rerun` names the run whose jobs a rerun
 * would settle, where none failed on its own steps.
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
        wait: true,
        sentence: `${REFUSAL}: a CI run is still running on ${at} (${status.url}). Cut again once it has finished; if it was not a whole-suite run, that cut starts one.`,
      };
    case 'red': {
      const failing =
        status.failing.length > 0 ? status.failing.join(', ') : `concluded ${status.conclusion}`;
      if (!status.onATest && status.runId !== null && status.runId !== undefined) {
        return {
          ok: false,
          dispatch: false,
          rerun: status.runId,
          sentence: `${REFUSAL}: the whole suite is red on ${at} (${status.url}), but no job failed on its own steps: ${failing}. A rerun settles it, not a fix: ${rerunCommand(status.runId)}, then cut again.`,
        };
      }
      return {
        ok: false,
        dispatch: false,
        sentence: `${REFUSAL}: the whole suite is red on ${at} (${status.url}): ${failing}. Its suite-bisect job names the merge that broke it. Land the fix, then cut on the commit that carries it.`,
      };
    }
    default:
      return {
        ok: false,
        dispatch: true,
        sentence: `${REFUSAL}: ${at} has no whole-suite run, so nothing says every suite passes on what this cut would ship.`,
      };
  }
}

/**
 * Where the suspects start: the green whole-suite run that holds the newest of the red commit's
 * first-parent landings, or null where none in the window does.
 *
 * `history.landings` is the red commit's first-parent history, newest first and the red commit
 * itself first; `history.ancestors` every commit those landings brought in, through any parent,
 * newest first; `history.holds(a, b)` whether commit `b` is `a` or an ancestor of it. A green run
 * counts wherever it sits, not only on the first-parent line: a merge of `origin/dev` into a local
 * `dev` puts the branch's own line second, and a green run there (6885f4552, reaching 00176acd7
 * through the second parent of 0f5c17610) holds every landing it reaches, which are then no
 * suspect (ISS-471's judge, comment 49f4b0cd). Answers `{ green, index }`, `index` the newest
 * landing `green` holds.
 */
export function lastGreen(reader, { landings, ancestors, holds }) {
  let best = null;
  for (const sha of ancestors) {
    // A commit the best green's landing already holds holds no newer landing than it.
    if (best && holds(landings[best.index], sha)) continue;
    if (newest(reader.checkRuns(sha), WHOLE_SUITE_CHECK)?.conclusion !== 'success') continue;
    const before = best ? best.index : landings.length;
    const index = landings.findIndex((l, i) => i > 0 && i < before && holds(sha, l));
    if (index !== -1) best = { green: sha, index };
    if (best?.index === 1) break;
  }
  return best;
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
 * failing job recorded as succeeding there. `bad`: one failing job recorded as failing there.
 * Null where nothing recorded says either. A red whole-suite run is not read as bad by itself: it
 * may be red for a job that is not failing now, or for a cancelled leg, so its own jobs' checks on
 * the commit are read instead, as on any other run. A check of another name (a merge check that
 * ran a selection) is not read: it may not have run the test now failing, which is the red a
 * passed merge check missed. A skipped check is no record (`ranNothing`).
 */
export function evidenceOf(checkRuns, failingNames) {
  if (newest(checkRuns, WHOLE_SUITE_CHECK)?.conclusion === 'success') return 'good';
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

/**
 * The sentence a red whole-suite run leaves, naming the merge or the range. With no `result` no job
 * failed on its own steps, so there is nothing to bisect and no merge is named: a rerun settles it.
 */
export function bisectReport({ red, failing, green, result, searched, runId }) {
  const head = `The whole suite went red on ${short(red)}: ${failing.length > 0 ? failing.join(', ') : 'no failing job was read'}.`;
  if (!result) {
    return `${head}\nNo job failed on its own steps, so no merge is named: a rerun settles it, not a fix (${rerunCommand(runId)}).`;
  }
  const since = green
    ? `Last green whole-suite run: ${short(green)}.`
    : `No green whole-suite run on any commit the last ${searched} first-parent landings brought in, so the range runs from the oldest of them.`;
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
