import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The state one required check reported at one commit. From GitHub through `gh api`, or — for a
 * window run where the remote is not GitHub, or replayed later — from a file saved from it, shaped
 * `{ "<sha>": { "<check>": "<conclusion>" } }`. An absent check is `absent`, never a pass.
 */
export function checkReader({ repoSlug, file }) {
  if (file) {
    let saved;
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      return () => ({ refusal: `the checks file ${file} is not readable JSON: ${err.message}` });
    }
    return (sha, name) => ({ state: saved?.[sha]?.[name] ?? 'absent' });
  }
  return (sha, name) => {
    const path = `repos/${repoSlug}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}`;
    const r = spawnSync('gh', ['api', path, '--jq', '.check_runs'], { encoding: 'utf8' });
    if (r.status !== 0) {
      return {
        refusal: `\`gh api ${path}\` did not answer (${(r.stderr || '').trim()}), so ${name} at ${sha} is unknown`,
      };
    }
    const runs = JSON.parse(r.stdout || '[]');
    if (runs.length === 0) return { state: 'absent' };
    const newest = runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
    return {
      state: newest.status === 'completed' ? newest.conclusion : newest.status,
      url: newest.html_url,
    };
  };
}

/** `owner/name` of the `origin` remote on GitHub, or `null` where it is not a GitHub remote. */
export function repoSlugOf(git) {
  const url = git.run(['remote', 'get-url', 'origin'])?.trim() ?? '';
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}
