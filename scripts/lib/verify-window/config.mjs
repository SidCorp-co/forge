/**
 * The declarations a verify window judges by, read at the window's BASE commit so that a member
 * cannot loosen the rule it is judged by. Every entry carries its reason, and a malformed file is
 * refused by name rather than read as "nothing is ineligible".
 */

export const CONFIG_PATH = '.forge/verify-queue.json';

/** `glob` as an anchored expression over a repository-relative path: `**`, `*` and `?`. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function refuse(where, what) {
  return { refusal: `${where}: ${what}` };
}

function reasonOf(entry) {
  return typeof entry?.reason === 'string' && entry.reason.trim().length >= 12;
}

/**
 * Parse the declarations. `where` names the file and the commit it was read at.
 * @returns {{ config: object } | { refusal: string }}
 */
export function parseConfig(text, where) {
  if (text === null) {
    return refuse(
      where,
      'there is no such file, so no admission rule is declared and none is assumed',
    );
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return refuse(where, `not readable JSON (${err.message})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refuse(where, 'the declarations must be one JSON object');
  }
  const dir = raw.migrations?.dir;
  if (typeof dir !== 'string' || dir === '') {
    return refuse(where, '`migrations.dir` must name the drizzle migrations directory');
  }
  const check = raw.check;
  if (typeof check !== 'string' || check === '') {
    return refuse(where, '`check` must name the one required check a member is green on');
  }
  const ineligible = raw.ineligible ?? {};
  if (typeof ineligible !== 'object' || Array.isArray(ineligible)) {
    return refuse(where, '`ineligible` must be an object of `paths`, `lines` and `linesIn`');
  }
  const union = raw.union ?? [];
  const paths = ineligible.paths ?? [];
  const lines = ineligible.lines ?? [];
  for (const [key, value] of [
    ['union', union],
    ['ineligible.paths', paths],
    ['ineligible.lines', lines],
  ]) {
    if (!Array.isArray(value)) return refuse(where, `\`${key}\` must be a list of entries`);
  }
  const linesIn = ineligible.linesIn ?? ['**'];
  if (!Array.isArray(linesIn) || linesIn.some((g) => typeof g !== 'string')) {
    return refuse(
      where,
      '`ineligible.linesIn` must list the globs whose added lines the line rules read',
    );
  }
  for (const [i, u] of union.entries()) {
    if (typeof u?.path !== 'string' || !reasonOf(u)) {
      return refuse(
        where,
        `union[${i}] needs a \`path\` and a \`reason\` of a dozen characters or more`,
      );
    }
  }
  const pathRules = [];
  for (const [i, p] of paths.entries()) {
    if (typeof p?.glob !== 'string' || !reasonOf(p)) {
      return refuse(where, `ineligible.paths[${i}] needs a \`glob\` and a \`reason\``);
    }
    pathRules.push({ glob: p.glob, reason: p.reason, re: globToRegExp(p.glob) });
  }
  const lineRules = [];
  for (const [i, l] of lines.entries()) {
    if (typeof l?.pattern !== 'string' || !reasonOf(l)) {
      return refuse(where, `ineligible.lines[${i}] needs a \`pattern\` and a \`reason\``);
    }
    let re;
    try {
      re = new RegExp(l.pattern);
    } catch (err) {
      return refuse(where, `ineligible.lines[${i}].pattern does not compile: ${err.message}`);
    }
    lineRules.push({ pattern: l.pattern, reason: l.reason, re });
  }
  return {
    config: {
      migrationsDir: dir.replace(/\/+$/, ''),
      check,
      union: union.map((u) => u.path),
      pathRules,
      lineRules,
      linesIn: linesIn.map(globToRegExp),
    },
  };
}
