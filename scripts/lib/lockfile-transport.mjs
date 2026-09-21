const HOST = String.raw`(?:\[[0-9a-fA-F:.]+\]|[\w.-]+)`;
// A pnpm dependency key is `<name>@<protocol>:<spec>`, which has the same shape as `user@host:path`.
// `file:`/`link:`/`workspace:`/`portal:` resolve on disk and clone nothing, so they are not a
// transport at all; excluding them by name keeps the check on the thing it was written for.
const LOCAL_PROTOCOL = String.raw`(?!(?:file|link|workspace|portal|npm|patch|catalog):)`;
const SSH_FORMS = [
  /\bssh:\/\//,
  new RegExp(String.raw`[\w.~-]+@${LOCAL_PROTOCOL}${HOST}:(?!//)(?!\d+/)[^\s,}]*/[^\s,}]*`),
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
