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

const HOST = String.raw`(?:\[[0-9a-fA-F:.]+\]|[\w.-]+)`;
const SSH_FORMS = [
  /\bssh:\/\//,
  new RegExp(String.raw`[\w.~-]+@${HOST}:(?!//)(?!\d+/)[^\s,}]*/[^\s,}]*`),
  new RegExp(String.raw`\brepo:\s*[\w.~-]+@${HOST}:(?!//)[^\s,}]+`),
];

const TRAILING_COMMENT = /\s#.*$/;

const KEY_LINE = /^(.+):(?:\s*\{\})?$/;

/** The key a line sits under: the nearest enclosing mapping key above it. */
function ownerOf(keysByIndent, indent) {
  const enclosing = [...keysByIndent.keys()].filter((i) => i < indent);
  if (enclosing.length === 0) return null;
  return keysByIndent.get(Math.max(...enclosing));
}

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
    if (raw.trimStart().startsWith('#')) return;
    const line = raw.replace(TRAILING_COMMENT, '');
    const indent = raw.length - raw.trimStart().length;
    for (const held of [...keysByIndent.keys()]) {
      if (held >= indent) keysByIndent.delete(held);
    }

    const trimmed = line.trim();
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
