// A board drawn on the Excalidraw canvas, read back as the wireframe-v1 document a requirement's
// picture stores (REQ-35, ISS-460). `board-canvas.tsx:toScene` draws a wireframe as Excalidraw
// elements, each box keeping its shape in `customData.wf`; this reads them the other way. An element
// a wireframe does not hold (an ellipse, a diamond, a line, an embedded image) is refused by its type,
// never guessed into the nearest shape, and the result is judged whole by `parseWireframe`.

import { parseWireframe, WIREFRAME_VERSION, type WireframeArrowEnd, type WireframeDoc, type WireframeShape } from "@forge/contracts/wireframe";

/** The fields of an Excalidraw element this reads; the canvas hands its scene elements as they are. */
export interface SceneElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  customData?: Record<string, unknown> | undefined;
  containerId?: string | null;
  text?: string;
  originalText?: string;
  points?: readonly (readonly [number, number])[];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
}

export type SceneReading =
  | { ok: true; doc: WireframeDoc }
  /** An element whose type no wireframe shape holds, named by that type. */
  | { ok: false; unsupported: string }
  /** The board read back, refused whole by `parseWireframe`, in its words. */
  | { ok: false; invalid: string };

const BOXES = new Set(["frame", "button", "input", "list", "image"]);

const textOf = (t: SceneElement) => t.originalText ?? t.text ?? "";
const tidy = (v: number) => Math.round(v * 10) / 10;

/** A box's shape, from the shape `toScene` kept on it and the words drawn inside it. */
function boxShape(el: SceneElement, words: string | null, at: { x: number; y: number }): WireframeShape {
  const kept = el.customData ?? {};
  const wf = typeof kept.wf === "string" && BOXES.has(kept.wf) ? kept.wf : "frame";
  const box = { id: el.id, x: at.x, y: at.y, w: tidy(el.width), h: tidy(el.height) };
  const lines = (words ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  switch (wf) {
    case "button":
      return { type: "button", ...box, label: words ?? "" };
    case "input": {
      const placeholder = typeof kept.placeholder === "string" ? kept.placeholder : undefined;
      const label = words && !(kept.label === undefined && words === placeholder) ? words : undefined;
      return { type: "input", ...box, ...(label ? { label } : {}), ...(placeholder ? { placeholder } : {}) };
    }
    case "list": {
      const labelled = typeof kept.label === "string" && lines.length > 0;
      return { type: "list", ...box, ...(labelled ? { label: lines[0] } : {}), items: labelled ? lines.slice(1) : lines };
    }
    case "image": {
      const label = (words ?? "").replace(/^\[image\]\s*/, "").trim();
      return { type: "image", ...box, ...(label ? { label } : {}) };
    }
    default:
      return { type: "frame", ...box, ...(words ? { label: words } : {}) };
  }
}

/** The board the scene holds, moved whole onto the wireframe canvas where it was drawn above or left of it. */
export function sceneToWireframe(elements: readonly SceneElement[], title?: string): SceneReading {
  const live = elements.filter((e) => !e.isDeleted);
  const bound = new Map(live.filter((e) => e.type === "text" && e.containerId).map((e) => [e.containerId as string, textOf(e)]));
  const drawn = live.filter((e) => !(e.type === "text" && e.containerId));
  const odd = drawn.find((e) => !["rectangle", "text", "arrow", "freedraw"].includes(e.type));
  if (odd) return { ok: false, unsupported: odd.type };

  const xs: number[] = [];
  const ys: number[] = [];
  for (const e of drawn) {
    const pts = e.type === "arrow" || e.type === "freedraw" ? (e.points ?? []) : [[0, 0] as const];
    for (const [px, py] of pts) {
      xs.push(e.x + px);
      ys.push(e.y + py);
    }
  }
  const dx = Math.max(0, -Math.min(0, ...xs));
  const dy = Math.max(0, -Math.min(0, ...ys));
  const at = (x: number, y: number) => ({ x: tidy(x + dx), y: tidy(y + dy) });
  const ids = new Set(drawn.filter((e) => e.type !== "arrow").map((e) => e.id));

  const shapes: WireframeShape[] = drawn.map((e): WireframeShape => {
    if (e.type === "text") return { type: "text", id: e.id, ...at(e.x, e.y), w: tidy(e.width), h: tidy(e.height), text: textOf(e) };
    if (e.type === "freedraw") {
      const points = (e.points ?? []).map(([px, py]): [number, number] => {
        const p = at(e.x + px, e.y + py);
        return [p.x, p.y];
      });
      return { type: "pen", id: e.id, points };
    }
    if (e.type === "arrow") {
      const pts = e.points ?? [];
      const end = (binding: SceneElement["startBinding"], p: readonly [number, number] | undefined): WireframeArrowEnd =>
        binding && ids.has(binding.elementId) ? { id: binding.elementId } : at(e.x + (p?.[0] ?? 0), e.y + (p?.[1] ?? 0));
      const label = bound.get(e.id);
      return { type: "arrow", id: e.id, from: end(e.startBinding, pts[0]), to: end(e.endBinding, pts.at(-1)), ...(label ? { label } : {}) };
    }
    return boxShape(e, bound.get(e.id) ?? null, at(e.x, e.y));
  });

  const parsed = parseWireframe({ v: WIREFRAME_VERSION, ...(title ? { title } : {}), shapes });
  return parsed.ok ? { ok: true, doc: parsed.doc } : { ok: false, invalid: parsed.message };
}
