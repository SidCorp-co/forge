// Which lockfile entries can only be fetched over SSH.
//
// This repository's CI is never given an SSH key, and a Dependabot-triggered
// workflow is never given a repository secret either, so a resolution naming
// `git@host:` or `ssh://` is one no job here can install. pnpm reports that as
// `git clone git@github.com:… exited 128`, before the job runs any of its own
// work — six jobs died that way for two days and none of them said why
// (ISS-1045).
//
// The text is scanned rather than parsed: this runs before `pnpm install`, so
// it has no YAML library and must not need one.

// cm:guard the scp-style `git@host:path` form is the one that matters and the one a regex most easily misses — Dependabot writes `git+https://git@github.com:owner/repo.git`, which starts with an https scheme and is still an SSH clone. Matching on the scheme alone would call that line clean.
const SSH_FORMS = [/\bgit@[\w.-]+:/, /\bssh:\/\//, /\bgit\+ssh:\/\//];

// cm:guard the `{}` tail is what makes a `snapshots:` row a key line too — drop it and an offending
// `pkg@git+ssh://…: {}` row is named by its section heading, `snapshots`, rather than by its package.
const KEY_LINE = /^(.+):(?:\s*\{\})?$/;

/** The key a line sits under: the nearest enclosing mapping key above it. */
function ownerOf(keysByIndent, indent) {
  const enclosing = [...keysByIndent.keys()].filter((i) => i < indent);
  if (enclosing.length === 0) return null;
  return keysByIndent.get(Math.max(...enclosing));
}

// cm:guard `scanned` counts resolutions and NOT lines, because its caller's fail-closed contract
// needs a count that reaches zero on a file that is not a lockfile, and a line count never does.
/**
 * Read a pnpm lockfile's text.
 *
 * @returns {{ scanned: number, offenders: Array<{ line: number, owner: string, text: string }> }}
 */
export function sshResolutions(text) {
  const keysByIndent = new Map();
  const offenders = [];
  let scanned = 0;

  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    const indent = raw.length - raw.trimStart().length;
    for (const held of [...keysByIndent.keys()]) {
      if (held >= indent) keysByIndent.delete(held);
    }

    const trimmed = raw.trim();
    const key = KEY_LINE.exec(trimmed)?.[1];
    if (trimmed.startsWith('resolution: {')) scanned += 1;

    if (SSH_FORMS.some((form) => form.test(raw))) {
      offenders.push({
        line: index + 1,
        owner: key ?? ownerOf(keysByIndent, indent) ?? '(top level)',
        text: trimmed,
      });
    }

    if (key !== undefined) keysByIndent.set(indent, key);
  });

  return { scanned, offenders };
}
