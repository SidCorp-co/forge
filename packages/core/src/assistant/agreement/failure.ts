// Why a pressed write did not land, in the sentence the thread shows the person. What the write
// answered is kept whole on the proposal (`failure`); the thread reads only the reason inside it — a
// problem document's detail, a tool's refusal, the CLI's own complaint — never the JSON around it.

const SAID_MAX = 400;

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

const oneLine = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
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
