// Why a pressed write did not land, in the sentence the thread shows the person. What the write
// answered is kept on the proposal (`failure`, {@link keptFailure}); the thread reads only the reason
// inside it — a problem document's detail, a tool's refusal, the CLI's own complaint — never the JSON
// around it, nor a raw id the refusal echoes.

const SAID_MAX = 400;
const KEPT_MAX = 1_000;
const UUID = /`?\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`?/gi;

type Json = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function objectOf(raw: string): Json | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

/** The reason a refusal's own words give, from the shapes a write answers with; null when none does. */
function reasonIn(answer: Json): string | null {
  const refusals = Array.isArray(answer.refusals) ? answer.refusals : [];
  const details = refusals.map((r) => text((r as Json | null)?.detail)).filter((d) => d !== null);
  const error = answer.error;
  const nested: Json = typeof error === 'object' && error !== null ? (error as Json) : {};
  const fromStream = text(answer.stderr) ?? text(answer.stdout);
  const inner = fromStream ? objectOf(fromStream) : null;
  return (
    text(answer.detail) ??
    (details.length > 0 ? details.join('; ') : null) ??
    text(nested.message) ??
    text(error) ??
    text(answer.message) ??
    (inner ? reasonIn(inner) : null) ??
    fromStream
  );
}

/** `v` with each string it already holds once dropped where it repeats, depth first. */
function withoutRepeats(v: unknown, seen: Set<string>): unknown {
  if (typeof v === 'string') {
    if (seen.has(v)) return undefined;
    seen.add(v);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => withoutRepeats(x, seen));
  if (typeof v !== 'object' || v === null) return v;
  const kept = Object.entries(v).map(([k, x]) => [k, withoutRepeats(x, seen)] as const);
  return Object.fromEntries(kept.filter(([, x]) => x !== undefined));
}

/**
 * What a refused write answered, as the proposal keeps it: whole up to its cap; past it, a JSON
 * answer keeps its JSON with each repeated string once (a problem body says its message four
 * times), so {@link failureSentence} and `refused-twice.ts:failureOf` still read its reason; else
 * clipped.
 */
export function keptFailure(answered: string): string {
  if (answered.length <= KEPT_MAX) return answered;
  const answer = objectOf(answered);
  const once = answer ? JSON.stringify(withoutRepeats(answer, new Set())) : null;
  return once && once.length <= KEPT_MAX ? once : `${answered.slice(0, KEPT_MAX - 1)}…`;
}

const oneLine = (s: string): string => {
  const flat = s.replace(UUID, 'the record').replace(/\s+/g, ' ').trim();
  return flat.length > SAID_MAX ? `${flat.slice(0, SAID_MAX - 1)}…` : flat;
};

const closed = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** The sentence a refused agreed write is told in: what refused it, and that nothing was written. */
export function failureSentence(failure: string): string {
  const answer = objectOf(failure);
  const reason = answer ? reasonIn(answer) : text(failure);
  const said = reason
    ? `It was refused: ${closed(oneLine(reason))}`
    : 'It was refused, and the refusal gave no reason.';
  return `${said} Nothing was written.`;
}
