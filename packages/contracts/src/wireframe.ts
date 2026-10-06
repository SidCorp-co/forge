// a board is a strict wireframe-v1 document rather than an Excalidraw scene: the run that builds an
// issue reads the attached board as its spec, so the shapes come from a closed set with stable ids and
// bounded geometry. A document that does not fit is refused by name — the code, the shape, the field —
// never clamped, never dropped, never guessed into the nearest shape that would still render.

import { z } from 'zod';

export const WIREFRAME_VERSION = 'wireframe-v1' as const;
/** The canvas every coordinate lives in: 0..CANVAS on both axes. */
const WIREFRAME_CANVAS = 4000;
const WIREFRAME_MAX_SHAPES = 500;
const WIREFRAME_MAX_PEN_POINTS = 2000;

/** The closed set. `pen` is in it so a stroke the person draws survives the round trip as itself. */
const WIREFRAME_SHAPE_TYPES = ['frame', 'text', 'button', 'input', 'list', 'image', 'arrow', 'pen'] as const;

const WIREFRAME_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const id = z.string().regex(WIREFRAME_ID_PATTERN, 'a shape id: 1-64 of A-Z a-z 0-9 _ -');
const coord = z.number().finite().min(0).max(WIREFRAME_CANVAS);
const size = z.number().finite().gt(0).max(WIREFRAME_CANVAS);
const label = z.string().max(200);
const box = { id, x: coord, y: coord, w: size, h: size };

const point = z.strictObject({ x: coord, y: coord });
const end = z.union([z.strictObject({ id }), point]);

const wireframeShapeSchemas = {
  frame: z.strictObject({ type: z.literal('frame'), ...box, label: label.optional() }),
  text: z.strictObject({ type: z.literal('text'), ...box, text: z.string().min(1).max(2000) }),
  button: z.strictObject({ type: z.literal('button'), ...box, label }),
  input: z.strictObject({ type: z.literal('input'), ...box, label: label.optional(), placeholder: label.optional() }),
  list: z.strictObject({ type: z.literal('list'), ...box, label: label.optional(), items: z.array(label).max(50) }),
  image: z.strictObject({ type: z.literal('image'), ...box, label: label.optional() }),
  arrow: z.strictObject({ type: z.literal('arrow'), id, from: end, to: end, label: label.optional() }),
  pen: z.strictObject({
    type: z.literal('pen'),
    id,
    points: z.array(z.tuple([coord, coord])).min(2).max(WIREFRAME_MAX_PEN_POINTS),
  }),
} as const;

export const wireframeShapeSchema = z.discriminatedUnion('type', [
  wireframeShapeSchemas.frame,
  wireframeShapeSchemas.text,
  wireframeShapeSchemas.button,
  wireframeShapeSchemas.input,
  wireframeShapeSchemas.list,
  wireframeShapeSchemas.image,
  wireframeShapeSchemas.arrow,
  wireframeShapeSchemas.pen,
]);
export type WireframeShape = z.infer<typeof wireframeShapeSchema>;
export type WireframeArrowEnd = z.infer<typeof end>;

export const wireframeDocSchema = z.strictObject({
  v: z.literal(WIREFRAME_VERSION),
  title: z.string().max(200).optional(),
  shapes: z.array(wireframeShapeSchema).max(WIREFRAME_MAX_SHAPES),
});
export type WireframeDoc = z.infer<typeof wireframeDocSchema>;

const shapeFields = z.record(z.string(), z.unknown());
const wireframePatchOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), shape: wireframeShapeSchema }),
  z.strictObject({ op: z.literal('update'), id, set: shapeFields }),
  z.strictObject({ op: z.literal('remove'), id }),
]);
type WireframePatchOp = z.infer<typeof wireframePatchOpSchema>;
export const wireframePatchSchema = z.array(wireframePatchOpSchema).min(1).max(200);

export type WireframeRefusalCode =
  | 'WIREFRAME_INVALID'
  | 'WIREFRAME_SHAPE_UNKNOWN'
  | 'WIREFRAME_OUT_OF_BOUNDS'
  | 'WIREFRAME_DUPLICATE_ID'
  | 'WIREFRAME_ARROW_DANGLING'
  | 'WIREFRAME_ID_MISSING';

type WireframeParse =
  | { ok: true; doc: WireframeDoc }
  | { ok: false; code: WireframeRefusalCode; path: string; message: string };

const refuse = (code: WireframeRefusalCode, path: string, detail: string): WireframeParse & { ok: false } => ({
  ok: false,
  code,
  path,
  message: `${code}: ${path} — ${detail}. The board was not changed.`,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function boundsRefusal(raw: Record<string, unknown>, at: string): (WireframeParse & { ok: false }) | null {
  const out = (field: string, detail: string) =>
    refuse('WIREFRAME_OUT_OF_BOUNDS', `${at}.${field}`, `${detail}; the canvas is 0..${WIREFRAME_CANVAS} on both axes`);
  const inCanvas = (v: unknown) => !isNum(v) || (v >= 0 && v <= WIREFRAME_CANVAS);
  if (raw.type === 'pen') {
    const pts = Array.isArray(raw.points) ? raw.points : [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (Array.isArray(p) && (!inCanvas(p[0]) || !inCanvas(p[1])))
        return out(`points.${i}`, `[${String(p[0])}, ${String(p[1])}] lies outside`);
    }
    return null;
  }
  if (raw.type === 'arrow') {
    for (const side of ['from', 'to'] as const) {
      const e = raw[side];
      if (isRecord(e) && !('id' in e)) {
        if (!inCanvas(e.x)) return out(`${side}.x`, `${String(e.x)} lies outside`);
        if (!inCanvas(e.y)) return out(`${side}.y`, `${String(e.y)} lies outside`);
      }
    }
    return null;
  }
  for (const f of ['x', 'y'] as const) if (!inCanvas(raw[f])) return out(f, `${String(raw[f])} lies outside`);
  for (const f of ['w', 'h'] as const) {
    const v = raw[f];
    if (isNum(v) && v <= 0) return out(f, `${v} is not a positive size`);
  }
  if (isNum(raw.x) && isNum(raw.w) && raw.x + raw.w > WIREFRAME_CANVAS)
    return out('w', `x + w = ${raw.x + raw.w} runs past the edge`);
  if (isNum(raw.y) && isNum(raw.h) && raw.y + raw.h > WIREFRAME_CANVAS)
    return out('h', `y + h = ${raw.y + raw.h} runs past the edge`);
  return null;
}

/**
 * Parse one document: the typed wireframe, or the first refusal naming its code and where it sits.
 * Order matters — an unknown shape is named as one before its fields are judged, and geometry is judged
 * before the schema so a shape off the canvas is OUT_OF_BOUNDS rather than a generic INVALID.
 */
export function parseWireframe(input: unknown): WireframeParse {
  if (!isRecord(input)) return refuse('WIREFRAME_INVALID', '(document)', 'a wireframe-v1 document is an object');
  if (input.v !== WIREFRAME_VERSION)
    return refuse('WIREFRAME_INVALID', 'v', `${JSON.stringify(input.v)} is not "${WIREFRAME_VERSION}"`);
  if (!Array.isArray(input.shapes)) return refuse('WIREFRAME_INVALID', 'shapes', 'an array of shapes is required');
  const seen = new Set<string>();
  for (let i = 0; i < input.shapes.length; i++) {
    const raw: unknown = input.shapes[i];
    const at = `shapes.${i}`;
    if (!isRecord(raw)) return refuse('WIREFRAME_INVALID', at, 'a shape is an object');
    if (!(WIREFRAME_SHAPE_TYPES as readonly unknown[]).includes(raw.type))
      return refuse(
        'WIREFRAME_SHAPE_UNKNOWN',
        `${at}.type`,
        `${JSON.stringify(raw.type)} is not a wireframe-v1 shape; the closed set is ${WIREFRAME_SHAPE_TYPES.join(', ')}`,
      );
    const bounds = boundsRefusal(raw, at);
    if (bounds) return bounds;
    if (typeof raw.id === 'string') {
      if (seen.has(raw.id))
        return refuse('WIREFRAME_DUPLICATE_ID', `${at}.id`, `"${raw.id}" is already the id of an earlier shape`);
      seen.add(raw.id);
    }
  }
  const parsed = wireframeDocSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? first.path.join('.') : '(document)';
    return refuse('WIREFRAME_INVALID', path, first?.message ?? 'does not parse');
  }
  const ids = new Set(parsed.data.shapes.map((s) => s.id));
  for (let i = 0; i < parsed.data.shapes.length; i++) {
    const s = parsed.data.shapes[i] as WireframeShape;
    if (s.type !== 'arrow') continue;
    for (const side of ['from', 'to'] as const) {
      const e = s[side];
      if ('id' in e && (!ids.has(e.id) || e.id === s.id))
        return refuse(
          'WIREFRAME_ARROW_DANGLING',
          `shapes.${i}.${side}.id`,
          `arrow "${s.id}" points at "${e.id}", which is not another shape on this board`,
        );
    }
  }
  return { ok: true, doc: parsed.data };
}

/** Apply a patch of shape edits by id, then judge the result whole: the revised board, or the refusal. */
export function applyWireframePatch(doc: WireframeDoc, opsInput: unknown): WireframeParse {
  const ops = wireframePatchSchema.safeParse(opsInput);
  if (!ops.success) {
    const first = ops.error.issues[0];
    const path = `ops${first?.path.length ? `.${first.path.join('.')}` : ''}`;
    if (first?.path.at(-1) === 'type' && first.path.includes('shape'))
      return refuse('WIREFRAME_SHAPE_UNKNOWN', path, `the closed set is ${WIREFRAME_SHAPE_TYPES.join(', ')}`);
    return refuse('WIREFRAME_INVALID', path, first?.message ?? 'does not parse');
  }
  let shapes: unknown[] = [...doc.shapes];
  for (let i = 0; i < ops.data.length; i++) {
    const op = ops.data[i] as WireframePatchOp;
    if (op.op === 'add') {
      shapes.push(op.shape);
      continue;
    }
    const at = shapes.findIndex((s) => (s as WireframeShape).id === op.id);
    if (at < 0) return refuse('WIREFRAME_ID_MISSING', `ops.${i}.id`, `no shape on this board has id "${op.id}"`);
    if (op.op === 'remove') shapes = shapes.filter((_, j) => j !== at);
    else {
      if ('id' in op.set || 'type' in op.set)
        return refuse('WIREFRAME_INVALID', `ops.${i}.set`, 'an update cannot change a shape\'s id or type; remove it and add another');
      shapes[at] = { ...(shapes[at] as WireframeShape), ...op.set };
    }
  }
  return parseWireframe({ ...doc, shapes });
}

/** The board as the one line the person and the model read: its title and what it holds. */
export function describeWireframe(doc: WireframeDoc): string {
  const counts = new Map<string, number>();
  for (const s of doc.shapes) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
  const what = [...counts].map(([t, n]) => `${n} ${t}`).join(', ');
  return `${doc.title ? `"${doc.title}" ` : ''}board (${what || 'empty'})`;
}
