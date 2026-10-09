"use client";

// Drawing or replacing a requirement's picture on its page (REQ-35 BC-10, BC-12; Requirement
// lifecycle r14 edge `picture.drawn or replaced`): one editor per kind, each with the text
// alternative a screen reader reads, written by the person. Core judges what is sent; each refusal it
// names shows in its own words, without its code, on the field its path names, and one naming no field
// shows below. A
// refusal of the kind (`/kind`) is the kind field's, which the region above draws. A wireframe is
// read from the board only once the board has reported its scene, and an empty board is refused
// here, so a drawn wireframe is never replaced by a board that had not loaded.

import type { ExampleTableContent, PictureKind, RequirementPictureView, WritePictureRequest } from "@forge/contracts/requirement-pictures";
import { parseWireframe, type WireframeDoc } from "@forge/contracts/wireframe";
import dynamic from "next/dynamic";
import { type ReactNode, useRef, useState } from "react";
import { Button, Field, IconButton, Input, NativeSelect, Textarea } from "@/design";
import { type SceneElement, sceneToWireframe } from "@/features/board/scene-to-wireframe";
import { namedRefusals } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { useWriteRequirementPicture } from "../hooks";
import {
  type ChartDraft,
  chartDraftOf,
  chartFromDraft,
  type FlowFault,
  fieldOfPath,
  flowFromLines,
  flowToLines,
  type PictureField,
  tableRowsOf,
} from "../picture-model";
import { plainRefusal } from "./requirement-kind-field";

const BoardEditor = dynamic(() => import("@/features/board/board-editor"), { ssr: false });

type Content<K extends PictureKind> = Extract<WritePictureRequest, { kind: K }>["content"];
type Built = { ok: true; body: WritePictureRequest } | { ok: false; field: PictureField; text: string };

function flowFaultText(f: FlowFault, t: Copy): string {
  if (f.fault === "none") return t("requirements.picture.edit.noSteps");
  if (f.fault === "repeated") return t("requirements.picture.edit.repeatedStep", { n: f.line, name: f.name });
  if (f.fault === "notLink") return t("requirements.picture.edit.notLink", { n: f.line });
  return t("requirements.picture.edit.unknownStep", { n: f.line, name: f.name ?? "" });
}

/** A stored picture's title, which every kind but the wireframe keeps in its content and the wireframe on its board. */
function titleOf(p: RequirementPictureView | null): string {
  if (!p) return "";
  const c = p.content as { title?: string; board?: { title?: string } };
  return c.title ?? c.board?.title ?? "";
}

function boardOf(p: RequirementPictureView | null): WireframeDoc | null {
  if (p?.kind !== "wireframe") return null;
  const read = parseWireframe((p.content as Content<"wireframe">).board);
  return read.ok ? read.doc : null;
}

/** The elements a board can hold that a wireframe does not keep, each with its name in the copy. */
const ELEMENT_NAMED = ["ellipse", "diamond", "line", "image", "frame", "magicframe", "embeddable", "iframe"] as const;

function unsupportedText(type: string, t: Copy): string {
  const named = ELEMENT_NAMED.find((e) => e === type);
  const what = named ? t(`requirements.picture.edit.element.${named}`) : t("requirements.picture.edit.element.other", { type });
  return t("requirements.picture.edit.unsupported", { what });
}

const BLANK_CHART: ChartDraft = { variant: "bar", xLabel: "", valueLabel: "", rows: [{ label: "", value: "" }] };

export function PictureEditor({
  revision,
  kind,
  picture,
  save,
  onDone,
}: {
  revision: number;
  kind: PictureKind;
  /** The picture it replaces, which the editor opens on; null draws a first one. */
  picture: RequirementPictureView | null;
  /** The picture write, held by the region so a refusal of the kind shows on the kind field. */
  save: ReturnType<typeof useWriteRequirementPicture>;
  onDone: () => void;
}) {
  const t = useCopy();
  const own = picture?.kind === kind ? picture : null;
  const [alt, setAlt] = useState(own?.alt ?? "");
  const [title, setTitle] = useState(titleOf(own));
  const [flow, setFlow] = useState(() => (own?.kind === "flow" ? flowToLines(own.content as Content<"flow">) : { steps: "", links: "" }));
  const [rows, setRows] = useState<ExampleTableContent["rows"]>(() => tableRowsOf(own));
  const storedChart = own?.kind === "chart" ? chartDraftOf(own.content as Content<"chart">) : null;
  const [chart, setChart] = useState<ChartDraft>(storedChart ?? BLANK_CHART);
  const scene = useRef<readonly SceneElement[] | null>(null);
  const [boardShown, setBoardShown] = useState(false);
  const [startBoard] = useState(() => boardOf(own));
  const [local, setLocal] = useState<{ field: PictureField; text: string } | null>(null);

  const refusals = namedRefusals(save.error);
  const at = (field: PictureField): string | undefined =>
    local?.field === field ? local.text : refusals.find((r) => fieldOfPath(r.path, kind) === field)?.detail;
  const unplaced = refusals.filter((r) => {
    const f = fieldOfPath(r.path, kind);
    return f === null || f === "content" || (f.startsWith("row:") && kind !== "example_table");
  });
  const named = title.trim() || undefined;

  const build = (): Built => {
    if (kind === "flow") {
      const read = flowFromLines(flow.steps, flow.links, named);
      return read.ok ? { ok: true, body: { kind, alt, content: read.content } } : { ok: false, field: read.fault.field, text: flowFaultText(read.fault, t) };
    }
    if (kind === "example_table") return { ok: true, body: { kind, alt, content: { ...(named ? { title: named } : {}), rows } } };
    if (kind === "chart") {
      const read = chartFromDraft(chart, named);
      if (read.ok) return { ok: true, body: { kind, alt, content: read.content } };
      const f = read.fault;
      if (f.field === "row") return { ok: false, field: "content", text: t("requirements.picture.edit.notNumber", { n: f.row }) };
      return f.field === "rows"
        ? { ok: false, field: "content", text: t("requirements.picture.edit.noFigures") }
        : { ok: false, field: f.field, text: t("requirements.picture.edit.nameAxis") };
    }
    if (!scene.current) return { ok: false, field: "board", text: t("requirements.picture.edit.boardLoading") };
    const read = sceneToWireframe(scene.current, named);
    if (!read.ok) return { ok: false, field: "board", text: "unsupported" in read ? unsupportedText(read.unsupported, t) : read.invalid };
    if (read.doc.shapes.length === 0) return { ok: false, field: "board", text: t("requirements.picture.edit.emptyBoard") };
    return { ok: true, body: { kind, alt, content: { board: read.doc } } };
  };
  const waiting = kind === "wireframe" && !boardShown;

  const submit = () => {
    const built = build();
    if (!built.ok) {
      setLocal({ field: built.field, text: built.text });
      return;
    }
    setLocal(null);
    save.mutate({ revision, body: built.body }, { onSuccess: onDone });
  };

  return (
    <div className="mt-4 grid max-w-[880px] gap-4 border-t border-line-subtle pt-4" data-testid="picture-editor" data-picture={kind}>
      <Field label={t("requirements.picture.edit.title")}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {kind === "flow" ? <FlowFields flow={flow} onFlow={setFlow} at={at} t={t} /> : null}
      {kind === "example_table" ? <TableFields rows={rows} onRows={setRows} at={at} t={t} /> : null}
      {kind === "chart" ? <ChartFields chart={chart} onChart={setChart} at={at} other={own?.kind === "chart" && !storedChart} t={t} /> : null}
      {kind === "wireframe" ? (
        <Field label={t("requirements.picture.edit.board")} hint={t(waiting ? "requirements.picture.edit.boardLoading" : "requirements.picture.edit.boardHint")} error={at("board")}>
          <div className="h-[420px] border border-line-subtle max-md:h-[360px]" data-testid="picture-board-editor">
            <BoardEditor
              doc={startBoard}
              onScene={(els) => {
                scene.current = els;
                setBoardShown(true);
              }}
            />
          </div>
        </Field>
      ) : null}
      <Field label={t("requirements.picture.edit.alt")} hint={t("requirements.picture.edit.altHint")} error={at("alt")} required>
        <Textarea rows={2} value={alt} onChange={(e) => setAlt(e.target.value)} />
      </Field>
      {local?.field === "content" ? <p role="alert" className="fg-caption text-[color:var(--red-600)]">{local.text}</p> : null}
      {unplaced.map((r) => (
        <p key={`${r.code}:${r.path}`} role="alert" className="fg-caption text-[color:var(--red-600)]" data-testid="refusal">
          {r.detail}
        </p>
      ))}
      {save.error && refusals.length === 0 ? (
        <p role="alert" className="fg-caption text-[color:var(--red-600)]" data-testid="refusal">
          {plainRefusal(save.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="primary" loading={save.isPending} disabled={waiting} onClick={submit}>
          {t("requirements.picture.edit.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("requirements.picture.edit.cancel")}
        </Button>
      </div>
    </div>
  );
}

type At = (field: PictureField) => string | undefined;

function FlowFields({ flow, onFlow, at, t }: { flow: { steps: string; links: string }; onFlow: (f: { steps: string; links: string }) => void; at: At; t: Copy }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label={t("requirements.picture.edit.steps")} hint={t("requirements.picture.edit.stepsHint")} error={at("steps")}>
        <Textarea rows={6} value={flow.steps} onChange={(e) => onFlow({ ...flow, steps: e.target.value })} />
      </Field>
      <Field label={t("requirements.picture.edit.links")} hint={t("requirements.picture.edit.linksHint")} error={at("links")}>
        <Textarea rows={6} value={flow.links} onChange={(e) => onFlow({ ...flow, links: e.target.value })} />
      </Field>
    </div>
  );
}

function Pair({ children, error, onRemove, removeLabel }: { children: ReactNode; error: string | undefined; onRemove: () => void; removeLabel: string }) {
  return (
    <li className="grid gap-1">
      <div className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-2 md:grid-cols-2">{children}</div>
        <IconButton icon="x" size="sm" aria-label={removeLabel} onClick={onRemove} />
      </div>
      {error ? (
        <p role="alert" className="fg-caption text-[color:var(--red-600)]">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function TableFields({ rows, onRows, at, t }: { rows: ExampleTableContent["rows"]; onRows: (r: ExampleTableContent["rows"]) => void; at: At; t: Copy }) {
  const set = (i: number, half: "input" | "expected", v: string) => onRows(rows.map((r, j) => (j === i ? { ...r, [half]: v } : r)));
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-2 pr-9 text-12 font-semibold text-subtle max-md:hidden">
        <span>{t("requirements.picture.table.input")}</span>
        <span>{t("requirements.picture.table.expected")}</span>
      </div>
      <ul className="grid gap-2">
        {rows.map((r, i) => (
          // an example row has no key of its own; its place is its name in a refusal (row n)
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <Pair key={i} error={at(`row:${i}`)} onRemove={() => onRows(rows.filter((_, j) => j !== i))} removeLabel={t("requirements.picture.edit.removeRow", { n: i + 1 })}>
            <Input aria-label={t("requirements.picture.edit.rowInput", { n: i + 1 })} value={r.input ?? ""} onChange={(e) => set(i, "input", e.target.value)} />
            <Input aria-label={t("requirements.picture.edit.rowExpected", { n: i + 1 })} value={r.expected ?? ""} onChange={(e) => set(i, "expected", e.target.value)} />
          </Pair>
        ))}
      </ul>
      <Button type="button" size="sm" variant="secondary" className="w-fit" onClick={() => onRows([...rows, { input: "", expected: "" }])}>
        {t("requirements.picture.edit.addRow")}
      </Button>
    </div>
  );
}

function ChartFields({ chart, onChart, at, other, t }: { chart: ChartDraft; onChart: (c: ChartDraft) => void; at: At; other: boolean; t: Copy }) {
  const set = (i: number, half: "label" | "value", v: string) => onChart({ ...chart, rows: chart.rows.map((r, j) => (j === i ? { ...r, [half]: v } : r)) });
  return (
    <div className="grid gap-3">
      {other ? <p className="text-13 text-muted">{t("requirements.picture.edit.chartOther")}</p> : null}
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={t("requirements.picture.edit.chart")}>
          <NativeSelect
            value={chart.variant}
            onChange={(e) => onChart({ ...chart, variant: e.target.value === "line" ? "line" : "bar" })}
            options={[
              { value: "bar", label: t("requirements.picture.edit.bar") },
              { value: "line", label: t("requirements.picture.edit.line") },
            ]}
          />
        </Field>
        <Field label={t("requirements.picture.edit.xLabel")} error={at("xLabel")}>
          <Input value={chart.xLabel} onChange={(e) => onChart({ ...chart, xLabel: e.target.value })} />
        </Field>
        <Field label={t("requirements.picture.edit.valueLabel")} error={at("valueLabel")}>
          <Input value={chart.valueLabel} onChange={(e) => onChart({ ...chart, valueLabel: e.target.value })} />
        </Field>
      </div>
      <ul className="grid gap-2">
        {chart.rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <Pair key={i} error={undefined} onRemove={() => onChart({ ...chart, rows: chart.rows.filter((_, j) => j !== i) })} removeLabel={t("requirements.picture.edit.removeRow", { n: i + 1 })}>
            <Input aria-label={t("requirements.picture.edit.rowLabel", { n: i + 1 })} value={r.label} onChange={(e) => set(i, "label", e.target.value)} />
            <Input aria-label={t("requirements.picture.edit.rowValue", { n: i + 1 })} inputMode="decimal" value={r.value} onChange={(e) => set(i, "value", e.target.value)} />
          </Pair>
        ))}
      </ul>
      <Button type="button" size="sm" variant="secondary" className="w-fit" onClick={() => onChart({ ...chart, rows: [...chart.rows, { label: "", value: "" }] })}>
        {t("requirements.picture.edit.addRow")}
      </Button>
    </div>
  );
}
