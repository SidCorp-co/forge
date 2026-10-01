import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Which branch a change in this checkout will land on, and which ref names it here (ISS-1304).
 *
 * Derived from the run, never read from configuration, so one answer is right on a GitHub runner
 * and on a laptop. The sources, the refusals, why there is no fourth source and how to scope a
 * local run to a non-default base: `scripts/README.md`.
 */

const REMOTE = 'origin';

/** The ci.yml step whose shell names every branch that workflow treats as already proved. */
export const PROVED_STEP = 'Whether a pull_request run already proved this exact tree';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function shortBranch(value) {
  const name = String(value ?? '').trim();
  return name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name;
}

function withoutRemote(ref) {
  return ref.startsWith(`${REMOTE}/`) ? ref.slice(REMOTE.length + 1) : ref;
}

const SOURCES = [
  '$GITHUB_BASE_REF, the base of the pull request being built',
  '$GITHUB_REF on a push or schedule event, where it names a branch',
  'inputs.base in the $GITHUB_EVENT_PATH payload of a workflow_dispatch event',
  `refs/remotes/${REMOTE}/HEAD, git's record of the remote's default branch`,
];

const NO_TARGET_SUMMARY =
  'no merge target could be derived, so there is no branch to measure this change against';

const NO_TARGET =
  `${NO_TARGET_SUMMARY}.\n` +
  `Four sources were read, in this order:\n${SOURCES.map((s) => `  - ${s}`).join('\n')}\n` +
  `Set the fourth with \`git remote set-head ${REMOTE} -a\`, or fetch the branch this work is cut\n` +
  'from. Nothing falls back to `main`: measuring a delta against a branch the work does not\n' +
  'derive from reports a pass it has not earned, which is the failure this refusal exists to stop.';

/**
 * A dispatched run's own statement of where its branch lands. `$GITHUB_REF` there is the branch
 * being run, not its target, and GitHub cannot know the target, so the dispatcher names it.
 */
function dispatchedBase(env) {
  const path = String(env.GITHUB_EVENT_PATH ?? '').trim();
  const refuse = (why) => {
    const summary = `a workflow_dispatch run names its merge target in inputs.base, and ${why}`;
    return {
      summary,
      refusal:
        `${summary}.\n` +
        'Dispatch it as `gh workflow run CI --ref <branch> -f base=<the branch it lands on>`. No\n' +
        `other source is read for a dispatched run: ${REMOTE}/HEAD names the default branch, which\n` +
        'is not where every dispatched branch lands, and a delta measured against the wrong base\n' +
        'reports a pass it has not earned.',
    };
  };
  if (!path) return refuse('$GITHUB_EVENT_PATH is unset, so there is no payload to read it from');
  let payload;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return refuse(`the payload at ${path} could not be read as JSON (${e.message})`);
  }
  const base = shortBranch(payload?.inputs?.base);
  if (!base) return refuse(`the payload at ${path} names none`);
  return { branch: base, source: 'inputs.base' };
}

/** How long the remote is given to name its default before the record is used unconfirmed. */
const REMOTE_HEAD_TIMEOUT_MS = 10_000;

/**
 * The remote's own default branch, asked of it, or why it could not answer. A recorded
 * `origin/HEAD` is what the remote said at clone time; it does not move when the remote's default
 * does, and a checkout reading it measures the old base with nothing said.
 */
function remoteDefault(root) {
  const r = spawnSync('git', ['ls-remote', '--symref', REMOTE, 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: REMOTE_HEAD_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) return { unanswered: r.error.message };
  if (r.status !== 0) {
    return { unanswered: (r.stderr || `exit ${r.status}`).trim().split('\n')[0] };
  }
  const m = /^ref:\s*refs\/heads\/(\S+)\s+HEAD$/m.exec(r.stdout);
  return m ? { branch: m[1] } : { unanswered: 'the remote named no default branch' };
}

/**
 * The recorded default, held to what the remote says now. A disagreement is refused: the record is
 * a measurement against a branch this work no longer lands on. A remote that cannot be asked leaves
 * the record standing, said on stderr, since a checkout offline still knows where it was cut from.
 */
function confirmedDefault(root, recorded) {
  const now = remoteDefault(root);
  if (now.branch && now.branch !== recorded) {
    const summary =
      `refs/remotes/${REMOTE}/HEAD records \`${recorded}\` as the remote's default, and the remote ` +
      `now names \`${now.branch}\``;
    return {
      summary,
      refusal:
        `${summary}.\n` +
        `The record is stale, so measuring against it would measure against a branch this work no\n` +
        `longer lands on. Refresh it with \`git remote set-head ${REMOTE} -a\` and run this again.`,
    };
  }
  if (now.unanswered) {
    process.stderr.write(
      `base-branch: the merge target \`${recorded}\` is ${REMOTE}/HEAD as recorded, unconfirmed: the ` +
        `remote could not be asked (${now.unanswered}). \`git remote set-head ${REMOTE} -a\` ` +
        'confirms it.\n',
    );
  }
  return { branch: recorded, source: `${REMOTE}/HEAD` };
}

/**
 * The branch this change will land on, from the first of `SOURCES` that answers. Each one
 * establishes the target; none infers it, and none falls back to `main`.
 *
 * @param {string} root a directory inside the checkout
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ branch: string, source: string } | { refusal: string, summary: string }}
 */
export function mergeTarget(root, env = process.env) {
  const prBase = shortBranch(env.GITHUB_BASE_REF);
  if (prBase) return { branch: prBase, source: 'GITHUB_BASE_REF' };

  // The ref, not `GITHUB_REF_NAME`: a tag push is a push event and carries a ref name too. A
  // schedule run checks out the head of the branch this names, so, as on a push, that branch is
  // the tree itself.
  const event = String(env.GITHUB_EVENT_NAME ?? '').trim();
  const pushedRef = String(env.GITHUB_REF ?? '').trim();
  if ((event === 'push' || event === 'schedule') && pushedRef.startsWith('refs/heads/')) {
    return { branch: shortBranch(pushedRef), source: 'GITHUB_REF' };
  }

  if (event === 'workflow_dispatch') return dispatchedBase(env);

  const head = git(['symbolic-ref', '--short', `refs/remotes/${REMOTE}/HEAD`], root);
  if (head) return confirmedDefault(root, withoutRemote(head));

  return { refusal: NO_TARGET, summary: NO_TARGET_SUMMARY };
}

/** The refs, in preference order, that could name `branch` in this checkout. */
export function refCandidates(branch) {
  return [`${REMOTE}/${branch}`, `refs/remotes/${REMOTE}/${branch}`, branch];
}

/** The merge target and the ref naming it here, or a refusal naming the branch and every ref tried. */
export function baseRef(root, env = process.env) {
  const target = mergeTarget(root, env);
  if (target.refusal) return target;

  const candidates = refCandidates(target.branch);
  const ref = candidates.find((c) => git(['rev-parse', '--verify', `${c}^{commit}`], root));
  if (ref) return { ...target, ref };

  const summary = `the merge target \`${target.branch}\` (from ${target.source}) resolves to no ref here`;
  return {
    summary,
    refusal:
      `${summary}. None of\n` +
      `${candidates.map((c) => `  ${c}`).join('\n')}\n` +
      `resolves in this checkout. Fetch it — \`git fetch ${REMOTE} ${target.branch}\` — and run\n` +
      'this again. Measuring against another branch instead would report a delta this change\n' +
      'does not have.',
  };
}

function onBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body;
}

function unquote(s) {
  return s.trim().replace(/^["']|["']$/g, '');
}

function branchesUnder(body, event) {
  const at = body.findIndex((l) => new RegExp(`^  ${event}:\\s*$`).test(l));
  if (at === -1) return null;
  for (let i = at + 1; i < body.length; i += 1) {
    if (/^ {2}\S/.test(body[i])) break;
    const inline = /^\s+branches:\s*\[([^\]]*)\]\s*$/.exec(body[i]);
    if (inline) return inline[1].split(',').map(unquote).filter(Boolean);
    if (/^\s+branches:\s*$/.test(body[i])) {
      const out = [];
      for (let j = i + 1; j < body.length; j += 1) {
        const item = /^\s+-\s*(.+?)\s*$/.exec(body[j]);
        if (!item) break;
        out.push(unquote(item[1]));
      }
      return out;
    }
  }
  return null;
}

function provedBranches(text) {
  const at = text.indexOf(PROVED_STEP);
  if (at === -1) return null;
  const rest = text.slice(at);
  const next = rest.search(/\n {6}- (?:name|uses|run|id|with):/);
  const block = next === -1 ? rest : rest.slice(0, next);
  const found = [...block.matchAll(/refs\/heads\/([A-Za-z0-9._/-]+)/g)].map((m) => m[1]);
  return found.length > 0 ? [...new Set(found)] : null;
}

/** The three branch sets one workflow names: both triggers, and the shell of `PROVED_STEP`. */
export function ciBranches(text) {
  const body = onBlock(text) ?? [];
  return {
    push: branchesUnder(body, 'push'),
    pullRequest: branchesUnder(body, 'pull_request'),
    proved: provedBranches(text),
  };
}

/** Which of those three disagree, and whether three agreeing lists leave `target` out. */
export function branchSetFaults(text, target = null) {
  const sets = ciBranches(text);
  const named = [
    ['on.push.branches', sets.push],
    ['on.pull_request.branches', sets.pullRequest],
    [`the \`${PROVED_STEP}\` step`, sets.proved],
  ];
  const missing = named.filter(([, v]) => v === null);
  if (missing.length > 0) return missing.map(([name]) => `${name}: not found`);

  const key = (v) => [...new Set(v)].sort().join(',');
  const agreed = key(named[0][1]);
  const faults = named.filter(([, v]) => key(v) !== agreed);
  if (faults.length > 0) return named.map(([name, v]) => `${name}: ${key(v) || '(empty)'}`);

  if (target && !named[0][1].includes(target)) {
    return [
      `all three name ${agreed || '(nothing)'}, and the merge target \`${target}\` is not among them`,
    ];
  }
  return [];
}
