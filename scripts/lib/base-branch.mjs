import { spawnSync } from 'node:child_process';

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
  '$GITHUB_REF on a push event, where it names a branch',
  `refs/remotes/${REMOTE}/HEAD, git's record of the remote's default branch`,
];

const NO_TARGET_SUMMARY =
  'no merge target could be derived, so there is no branch to measure this change against';

const NO_TARGET =
  `${NO_TARGET_SUMMARY}.\n` +
  `Three sources were read, in this order:\n${SOURCES.map((s) => `  - ${s}`).join('\n')}\n` +
  `Set the third with \`git remote set-head ${REMOTE} -a\`, or fetch the branch this work is cut\n` +
  'from. Nothing falls back to `main`: measuring a delta against a branch the work does not\n' +
  'derive from reports a pass it has not earned, which is the failure this refusal exists to stop.';

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

  // The ref, not `GITHUB_REF_NAME`: a tag push is a push event and carries a ref name too.
  const pushedRef = String(env.GITHUB_REF ?? '').trim();
  if (
    String(env.GITHUB_EVENT_NAME ?? '').trim() === 'push' &&
    pushedRef.startsWith('refs/heads/')
  ) {
    return { branch: shortBranch(pushedRef), source: 'GITHUB_REF' };
  }

  const head = git(['symbolic-ref', '--short', `refs/remotes/${REMOTE}/HEAD`], root);
  if (head) return { branch: withoutRemote(head), source: `${REMOTE}/HEAD` };

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
