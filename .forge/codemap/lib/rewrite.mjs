// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// codemap/1 §4 / principle 6 — the tool owns the format, so it owns the rewrite.
//
// The first implementation re-found the annotation with /(^|\s)(\/\/|#|--)\s*cm:.*$/ and counted every
// fix as applied. In JS `.` does not match \r and `$` without /m only matches end-of-string, so on a
// CRLF file the pattern matched nothing: `cm fmt` reported "1 normalized", wrote the file back byte
// for byte, and `cm verify` kept emitting a CM009 whose fix line said to run `cm fmt`. Unfixable
// diagnostics are how a validator gets switched off (principle 8), so the rewrite is now positional:
// the scanner already knows the column and the leader, and the line's own ending is preserved.

/**
 * @param {string} src
 * @param {Array<{line:number, col:number, leader:string, canonical:string}>} fixes
 * @returns {{src: string, applied: Array, failed: Array}}
 */
export function applyFmt(src, fixes) {
  const lines = src.split('\n');
  const applied = [];
  const failed = [];

  for (const fix of fixes) {
    const i = fix.line - 1;
    const line = lines[i];
    if (line === undefined || fix.col === undefined || !fix.leader || !fix.canonical) {
      failed.push(fix);
      continue;
    }
    // cm:why a \r here is the line ENDING, not content — dropping it converts this one line and leaves
    // the rest of a CRLF file mixed
    const eol = line.endsWith('\r') ? '\r' : '';
    const head = line.slice(0, fix.col);
    const rest = line.slice(fix.col, line.length - eol.length);
    if (!rest.startsWith(fix.leader)) { failed.push(fix); continue; }

    const next = `${head}${fix.leader} ${fix.canonical}${eol}`;
    if (next === line) { failed.push(fix); continue; }
    lines[i] = next;
    applied.push(fix);
  }

  return { src: lines.join('\n'), applied, failed };
}
