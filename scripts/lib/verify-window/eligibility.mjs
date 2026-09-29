/**
 * Whether one member may share a window at all: a change whose defects only the whole gate shows is
 * green on arrival and red where every other member pays for the round. Judged by surface, not size.
 */

const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path as git prints it: bare, or C-quoted with octal bytes for what it will not print raw. */
export function unquotePath(word) {
  if (!word.startsWith('"')) return word;
  const bytes = [];
  for (let i = 1; i < word.length - 1; i++) {
    if (word[i] !== '\\') {
      bytes.push(...Buffer.from(word[i]));
      continue;
    }
    const octal = word.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[word[i + 1]] ?? word.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The destination path of a `diff --git` header, quoted or bare. */
function headerPath(rest) {
  const quoted = rest.match(/"b\/(?:[^"\\]|\\.)*"$/);
  if (quoted) return unquotePath(quoted[0]).slice(2);
  const bare = rest.match(/^a\/(.+) b\/(.+)$/);
  return bare ? bare[2] : rest;
}

/**
 * The paths a `git diff --unified=0 --no-renames` touched, each with its added lines numbered; a
 * quoted path is decoded, so a declared glob sees the name the tree holds.
 * @returns {{ path: string, added: { line: number, text: string }[] }[]}
 */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let next = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = { path: headerPath(raw.slice('diff --git '.length)), added: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) {
      const side = unquotePath(raw.slice(4));
      if (side !== '/dev/null' && raw.startsWith('+++ ')) file.path = side.replace(/^b\//, '');
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      file.added.push({ line: next, text: raw.slice(1) });
      next += 1;
    }
  }
  return files;
}

/**
 * Every declared surface this member's diff touches, as the sentence its refusal carries.
 * @param {{ issue: string, files: ReturnType<typeof parseDiff> }} member
 * @param {{ pathRules: object[], lineRules: object[] }} config
 */
export function judgeEligibility(member, config) {
  const refusals = [];
  for (const f of member.files) {
    const byPath = config.pathRules.find((r) => r.re.test(f.path));
    if (byPath) {
      refusals.push({
        surface: 'path',
        file: f.path,
        rule: byPath.glob,
        message: `${member.issue} touches ${f.path}, which \`${byPath.glob}\` declares ineligible: ${byPath.reason}`,
      });
      continue;
    }
    if (!config.linesIn.some((re) => re.test(f.path))) continue;
    for (const rule of config.lineRules) {
      const hit = f.added.find((a) => rule.re.test(a.text));
      if (!hit) continue;
      refusals.push({
        surface: 'line',
        file: f.path,
        line: hit.line,
        rule: rule.pattern,
        message:
          `${member.issue} adds ${f.path}:${hit.line} \`${hit.text.trim().slice(0, 120)}\`, which ` +
          `matches \`${rule.pattern}\`: ${rule.reason}`,
      });
    }
  }
  return refusals;
}
