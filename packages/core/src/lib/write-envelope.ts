import { HTTPException } from 'hono/http-exception';

/** The body every revisioned document write takes: the revision it was read at, and the whole document. */
type WriteEnvelope = { baseRevision: number | null; document: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseWriteEnvelope(raw: unknown):
  | { ok: true; value: WriteEnvelope }
  | {
      ok: false;
      message: string;
    } {
  if (!isRecord(raw)) return { ok: false, message: 'the body must be { baseRevision, document }' };
  const extra = Object.keys(raw).filter((k) => k !== 'baseRevision' && k !== 'document');
  if (extra.length > 0) {
    return {
      ok: false,
      message: `unknown body key(s) ${extra.join(', ')}; the body is { baseRevision, document }`,
    };
  }
  if (!('baseRevision' in raw)) {
    return {
      ok: false,
      message:
        'baseRevision is required: the revision this write was read at, or null for a first write',
    };
  }
  const base = raw.baseRevision;
  if (base !== null && !(typeof base === 'number' && Number.isInteger(base) && base >= 1)) {
    return {
      ok: false,
      message: 'baseRevision must be a positive integer, or null for a first write',
    };
  }
  if (!('document' in raw)) return { ok: false, message: 'document is required' };
  return { ok: true, value: { baseRevision: base, document: raw.document } };
}

/** The write envelope of a request body, or a 400 naming what is wrong with its shape. */
export function envelopeOf(raw: unknown): WriteEnvelope {
  const envelope = parseWriteEnvelope(raw);
  if (!envelope.ok) {
    throw new HTTPException(400, {
      message: envelope.message,
      cause: { code: 'CONFIG_WRITE_SHAPE' },
    });
  }
  return envelope.value;
}
