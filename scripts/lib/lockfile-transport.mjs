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

// cm:guard the scp-style `user@host:path` form is the one that matters and the one a regex most
// easily misses — Dependabot writes `git+https://git@github.com:owner/repo.git`, an https scheme wrapping an SSH clone
// cm:guard the username is not `git` and the host is not always qualified — `deploy@gitlab:team/x.git`
// is an internal remote and reads the same, so neither is narrowed to the shape this issue met
// cm:guard the two lookaheads are what keep a lockfile's own rows out: `//` after the colon is a URL
// scheme, so `forge-plugin@https://codeload…` is the shipped entry and not a host called `https`
// cm:guard the path must carry a `/`, or every `pkg@1.2.3:` key line reads as a host and a path
// cm:guard a bracketed IPv6 literal is a host too, and its own colons are why it needs its own branch
// cm:guard `@host:1234/path` is a URL port to the general form and skipped, so a remote whose first
// path segment is all digits reaches the `repo:` branch below instead, which has no such doubt
// cm:guard the `repo:` branch drops the port lookahead because pnpm writes that field for a `type: git` resolution and nothing else — its value is always a bare remote, never a URL carrying userinfo, so there is no port to mistake a path for
const HOST = String.raw`(?:\[[0-9a-fA-F:]+\]|[\w.-]+)`;
const SSH_FORMS = [
  /\bssh:\/\//,
  new RegExp(String.raw`[\w.~-]+@${HOST}:(?!//)(?!\d+/)[^\s,}]*/[^\s,}]*`),
  new RegExp(String.raw`\brepo:\s*[\w.~-]+@${HOST}:(?!//)[^\s,}]*/[^\s,}]*`),
];

// cm:guard the strip takes only a `#` that follows whitespace, so it removes as little as it can — a
// git resolution's `…/repo.git#<sha>` is a fragment rather than a comment and stays on the line
// cm:guard stripping at all is safe only because pnpm writes no such comment — measured, neither this repo's lockfile nor the Dependabot one holds one ` #` line — and no test separates this from a strip at any `#`, because on every shape a lockfile holds the SSH form falls before the fragment
const TRAILING_COMMENT = /\s#.*$/;

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
    // cm:guard a comment is dropped BEFORE the forms run: a lockfile comment quoting an old
    // `git@host:owner/repo.git` is not a dependency, and accusing it blocks every install here
    if (raw.trimStart().startsWith('#')) return;
    const line = raw.replace(TRAILING_COMMENT, '');
    const indent = raw.length - raw.trimStart().length;
    for (const held of [...keysByIndent.keys()]) {
      if (held >= indent) keysByIndent.delete(held);
    }

    const trimmed = raw.trim();
    const key = KEY_LINE.exec(trimmed)?.[1];
    if (trimmed.startsWith('resolution: {')) scanned += 1;

    if (SSH_FORMS.some((form) => form.test(line))) {
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
