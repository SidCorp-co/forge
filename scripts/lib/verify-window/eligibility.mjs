/**
 * Whether one member may share a window at all: a change whose defects only the whole gate shows is
 * green on arrival and red where every other member pays for the round. Judged by surface, not size.
 */

/**
 * The paths a `git diff --unified=0 --no-renames` touched, each with its added lines numbered.
 * @returns {{ path: string, added: { line: number, text: string }[] }[]}
 */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let next = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = { path: m ? m[2] : raw.slice(11), added: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) continue;
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
