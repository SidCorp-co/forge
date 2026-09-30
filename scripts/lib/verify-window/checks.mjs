import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A check run as `gh api` returns it: timed, with a status, and a conclusion once completed. */
function isRun(run) {
  return (
    isRecord(run) &&
    typeof run.started_at === 'string' &&
    typeof run.status === 'string' &&
    (run.status !== 'completed' || typeof run.conclusion === 'string')
  );
}

/** `text` parsed as a JSON array of check runs, or `null` where it is not one. */
function runsOf(text) {
  try {
    const value = JSON.parse(text || '[]');
    return Array.isArray(value) && value.every(isRun) ? value : null;
  } catch {
    return null;
  }
}

/** Why a saved checks document is not `{ "<sha>": { "<check>": "<conclusion>" } }`, or `null`. */
function shapeOfSaved(saved) {
  if (!isRecord(saved)) return 'is not an object of commits';
  for (const [sha, checks] of Object.entries(saved)) {
    if (!isRecord(checks) || Object.values(checks).some((c) => typeof c !== 'string')) {
      return `holds ${sha} as something other than an object of check conclusions`;
    }
  }
  return null;
}

/**
 * The state one required check reported at one commit. From GitHub through `gh api`, or — for a
 * window run where the remote is not GitHub, or replayed later — from a file saved from it, shaped
 * `{ "<sha>": { "<check>": "<conclusion>" } }`. An absent check is `absent`, never a pass.
 */
export function checkReader({
  repoSlug,
  file,
  gh = (args) => spawnSync('gh', args, { encoding: 'utf8' }),
}) {
  if (file) {
    let saved;
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      return () => ({ refusal: `the checks file ${file} is not readable JSON: ${err.message}` });
    }
    const bad = shapeOfSaved(saved);
    if (bad) return () => ({ refusal: `the checks file ${file} ${bad}` });
    return (sha, name) => ({ state: saved[sha]?.[name] ?? 'absent' });
  }
  if (!repoSlug) {
    return (sha, name) => ({
      refusal: `origin is not a GitHub remote, so ${name} at ${sha} cannot be read from GitHub: pass \`--checks <file>\` saved from the check runs instead`,
    });
  }
  return (sha, name) => {
    const path = `repos/${repoSlug}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}`;
    const r = gh(['api', path, '--jq', '.check_runs']);
    if (r.status !== 0) {
      return {
        refusal: `\`gh api ${path}\` did not answer (${(r.stderr || '').trim()}), so ${name} at ${sha} is unknown`,
      };
    }
    const runs = runsOf(r.stdout);
    if (!runs) {
      return {
        refusal: `\`gh api ${path}\` answered \`${(r.stdout || '').trim().slice(0, 80)}\`, not a list of check runs each with its start, status and conclusion, so ${name} at ${sha} is unknown`,
      };
    }
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
