import { spawnSync } from 'node:child_process';

/**
 * A `git` bound to one directory. `run` answers stdout or `null`; `must` throws with git's own
 * stderr, so a step that cannot go on says which command stopped it.
 */
export function gitIn(cwd, env = process.env) {
  const call = (args, input) =>
    spawnSync('git', args, { cwd, env, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  return {
    cwd,
    raw: call,
    run(args, input) {
      const r = call(args, input);
      return r.status === 0 ? r.stdout : null;
    },
    must(args, input) {
      const r = call(args, input);
      if (r.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`);
      }
      return r.stdout;
    },
    ok(args) {
      return call(args).status === 0;
    },
  };
}

/** The file at `rev:path`, or `null` where that commit does not carry it. */
export function showAt(git, rev, path) {
  return git.run(['show', `${rev}:${path}`]);
}
