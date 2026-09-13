/** The prefix every project answered to before ISS-992, and the one a project with no prefix of
 *  its own still renders. It is never stored: a NULL `projects.issue_prefix` means this. */
export const LEGACY_ISSUE_PREFIX = 'ISS';

const PREFIX_SHAPE = /^[A-Z][A-Z0-9]{1,5}$/;
const REF_SHAPE = /^\s*(?:([A-Za-z][A-Za-z0-9]{1,5})-)?(\d{1,10})\s*$/;

// cm:guard the bound is int4's own range and NOT a digit count — `issSeq` is int4, so an
// out-of-range literal reaches Postgres as a 500 on what is a caller's typo (ISS-991)
export const ISS_SEQ_MAX = 2_147_483_647;

export function formatIssueRef(prefix: string | null | undefined, issSeq: number): string {
  return `${prefix ?? LEGACY_ISSUE_PREFIX}-${issSeq}`;
}

// cm:guard the form STORED in `pipeline_runs.metadata.runIssues` and matched by string containment in SQL, never parsed — it does not take the project's prefix. Keeping the two apart is why a project renamed to `FD` still gets its issues returned when its run's session ends (ISS-992). cm:edge lockstep -> packages/core/src/devices/admissible.ts — the SQL side of the same key
export function canonicalIssueKey(issSeq: number): string {
  return `${LEGACY_ISSUE_PREFIX}-${issSeq}`;
}

export type IssuePrefixShapeError = { ok: false; reason: 'shape' | 'reserved'; message: string };

export function validateIssuePrefix(
  raw: string,
): { ok: true; prefix: string } | IssuePrefixShapeError {
  const prefix = raw.trim().toUpperCase();
  if (!PREFIX_SHAPE.test(prefix)) {
    return {
      ok: false,
      reason: 'shape',
      message: `\`${raw}\` is not a usable issue prefix — it must be two to six characters, a letter followed by letters or digits, like \`FD\` or \`FP2\`.`,
    };
  }
  if (prefix === LEGACY_ISSUE_PREFIX) {
    return {
      ok: false,
      reason: 'reserved',
      message: `\`ISS\` is the shared legacy prefix every project already answers to, so no one project may hold it. Pick a prefix that names this project.`,
    };
  }
  return { ok: true, prefix };
}

/** The prefix token a reference carries, or null where it is a bare sequence number. Callers read
 *  this first so the common bare-number case spends no query resolving prefixes it will not use. */
export function issueRefPrefixOf(raw: string): string | null {
  return REF_SHAPE.exec(raw)?.[1]?.toUpperCase() ?? null;
}

/** Whether resolving this reference needs the project's held prefixes at all. A bare sequence
 *  number and the legacy prefix are admitted everywhere, so only a third token is worth a read. */
export function issueRefNeedsHeldPrefixes(raw: string): boolean {
  const given = issueRefPrefixOf(raw);
  return given !== null && given !== LEGACY_ISSUE_PREFIX;
}

export type ParsedIssueRef =
  | { ok: true; issSeq: number }
  | { ok: false; code: 'SHAPE' | 'FOREIGN_PREFIX' | 'RANGE'; message: string };

/** `accepts` is every prefix the project has ever held, active and retired alike; the legacy
 *  prefix is admitted on top of it and never has to be listed. */
export function parseIssueRef(raw: string, accepts: readonly string[] = []): ParsedIssueRef {
  const hit = REF_SHAPE.exec(raw);
  if (!hit?.[2]) {
    return {
      ok: false,
      code: 'SHAPE',
      message: `\`${raw}\` is not an issue reference — expected a display id like \`${LEGACY_ISSUE_PREFIX}-42\`, or its bare sequence number.`,
    };
  }
  const given = hit[1]?.toUpperCase();
  const held = [LEGACY_ISSUE_PREFIX, ...accepts.map((p) => p.toUpperCase())];
  if (given && !held.includes(given)) {
    return {
      ok: false,
      code: 'FOREIGN_PREFIX',
      message: `\`${raw}\` names the prefix \`${given}\`, which this project does not answer to — it answers to ${held.map((p) => `\`${p}\``).join(', ')}. A prefix names the project an issue belongs to, so \`${given}-${hit[2]}\` is a different issue somewhere else, not this project's ${hit[2]}.`,
    };
  }
  const issSeq = Number(hit[2]);
  if (issSeq < 1 || issSeq > ISS_SEQ_MAX) {
    return {
      ok: false,
      code: 'RANGE',
      message: `a display id runs from 1 to ${ISS_SEQ_MAX}`,
    };
  }
  return { ok: true, issSeq };
}
