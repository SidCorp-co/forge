// cm:why the canvas round-trips through wireframe-v1 on every edit: each element the board draws carries
// its wireframe shape in customData under the shape's own id, so a person's move keeps the id the
// assistant revises by. An element outside the closed set (ellipse, diamond, line, a pasted image) is
// not coerced into the nearest shape — the reading is refused by name and the board says which.

import {
  parseWireframe,
  WIREFRAME_ID_PATTERN,
  WIREFRAME_MAX_PEN_POINTS,
  type WireframeArrowEnd,
  type WireframeDoc,
  type WireframeShape,
  type WireframeShapeType,
} from "@forge/contracts/wireframe";

/** The fields of an Excalidraw element this reading uses — structural, so it needs no runtime import. */
export interface SceneElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  text?: string;
  containerId?: string | null;
  points?: readonly (readonly [number, number])[];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  customData?: Record<string, unknown>;
}

/** The wireframe fields a box keeps beside its geometry, stored on the element it renders as. */
export type BoxData = { wf: WireframeShapeType } & Record<string, unknown>;

const BOX_TYPES = new Set<WireframeShapeType>(["frame", "button", "input", "list", "image"]);
const r = (n: number) => Math.round(n);

/** The text a box shows inside it, and the field an edit to that text writes back to. */
export function boxText(s: WireframeShape): string {
  switch (s.type) {
    case "list":
      return [s.label, ...s.items].filter(Boolean).join("\n");
    case "input":
      return s.label ?? s.placeholder ?? "";
    case "image":
      return `[image] ${s.label ?? ""}`.trim();
    case "frame":
    case "button":
      return s.label ?? "";
    default:
      return "";
  }
}

function boxFromText(wf: WireframeShapeType, data: Record<string, unknown>, text: string | undefined) {
  const { wf: _wf, ...kept } = data;
  if (text === undefined) return kept;
  if (wf === "list") {
    const lines = text.split("\n");
    return data.label ? { ...kept, label: lines[0] ?? "", items: lines.slice(1) } : { ...kept, items: lines };
  }
  if (wf === "image") return { ...kept, label: text.replace(/^\[image\]\s*/, "") || undefined };
  if (wf === "input" && !data.label && data.placeholder !== undefined) return { ...kept, placeholder: text };
  return { ...kept, label: text };
}

function downsample(points: [number, number][]): [number, number][] {
  if (points.length <= WIREFRAME_MAX_PEN_POINTS) return points;
  const step = points.length / WIREFRAME_MAX_PEN_POINTS;
  return Array.from({ length: WIREFRAME_MAX_PEN_POINTS }, (_, i) => points[Math.floor(i * step)] as [number, number]);
}

export type SceneReading = { doc: WireframeDoc } | { refused: string };

/** Read what the canvas holds back into wireframe-v1, or the refusal naming what does not fit. */
export function readScene(elements: readonly SceneElement[], title?: string): SceneReading {
  const live = elements.filter((e) => !e.isDeleted);
  const labels = new Map<string, string>();
  for (const e of live) if (e.type === "text" && e.containerId) labels.set(e.containerId, e.text ?? "");
  const outside = new Map<string, number>();
  const shapes: unknown[] = [];
  for (const e of live) {
    const badId = !WIREFRAME_ID_PATTERN.test(e.id);
    if (badId) return { refused: `WIREFRAME_INVALID: element id "${e.id}" is not a wireframe-v1 id.` };
    if (e.type === "text") {
      if (e.containerId) continue;
      shapes.push({ type: "text", id: e.id, x: r(e.x), y: r(e.y), w: Math.max(1, r(e.width)), h: Math.max(1, r(e.height)), text: e.text || " " });
      continue;
    }
    if (e.type === "rectangle") {
      const data = (e.customData as BoxData | undefined) ?? { wf: "frame" };
      const wf = BOX_TYPES.has(data.wf) ? data.wf : "frame";
      shapes.push({ type: wf, id: e.id, x: r(e.x), y: r(e.y), w: Math.max(1, r(e.width)), h: Math.max(1, r(e.height)), ...boxFromText(wf, data, labels.get(e.id)) });
      continue;
    }
    if (e.type === "arrow") {
      const pts = e.points ?? [[0, 0]];
      const first = pts[0] ?? [0, 0];
      const last = pts[pts.length - 1] ?? first;
      const side = (binding: { elementId: string } | null | undefined, p: readonly [number, number]): WireframeArrowEnd =>
        binding?.elementId ? { id: binding.elementId } : { x: r(e.x + p[0]), y: r(e.y + p[1]) };
      const label = labels.get(e.id);
      shapes.push({ type: "arrow", id: e.id, from: side(e.startBinding, first), to: side(e.endBinding, last), ...(label ? { label } : {}) });
      continue;
    }
    if (e.type === "freedraw") {
      const pts = downsample((e.points ?? []).map(([px, py]) => [r(e.x + px), r(e.y + py)] as [number, number]));
      if (pts.length === 1) pts.push(pts[0] as [number, number]);
      shapes.push({ type: "pen", id: e.id, points: pts });
      continue;
    }
    outside.set(e.type, (outside.get(e.type) ?? 0) + 1);
  }
  if (outside.size > 0) {
    const what = [...outside].map(([t, n]) => `${n} ${t}`).join(", ");
    return {
      refused: `WIREFRAME_SHAPE_UNKNOWN: the board holds ${what}, outside wireframe-v1 (frame, text, button, input, list, image, arrow, pen). Delete or redraw ${outside.size === 1 && [...outside.values()][0] === 1 ? "it" : "them"} to send or attach the board.`,
    };
  }
  const parsed = parseWireframe({ v: "wireframe-v1", ...(title ? { title } : {}), shapes });
  return parsed.ok ? { doc: parsed.doc } : { refused: parsed.message };
}
