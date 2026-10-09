"use client";

// A requirement's picture, the first thing its page shows under the progress strip and above every
// text view (REQ-35 BC-1; Requirement lifecycle r14 steps picture, picture_none, picture_shown;
// Requirement to delivery r15 `req-head`). The kind chooses it (BC-2): a process its linked
// workflow with the steps and links its criteria trace lit and the rest dimmed (BC-3), or its rough
// flow where it links none; a rule its example table (BC-4); a screen its wireframe, drawn inline;
// a report its sample chart. Each is labelled a rough sketch (BC-11) and named for a screen reader
// by its text alternative (BC-12). No picture is an empty slot that nothing waits on (BC-14). A
// person holding project.write sets the kind and draws or replaces the picture here (BC-10).

import { type ExampleTableContent, PICTURE_KIND_OF, type RequirementKind, type RequirementPictureView } from "@forge/contracts/requirement-pictures";
import { parseWireframe } from "@forge/contracts/wireframe";
import dynamic from "next/dynamic";
import { type ReactNode, useId, useMemo, useState } from "react";
import { Button, NativeSelect } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
import { BLOCK_RENDERERS } from "@/features/visual-blocks";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useWriteRequirementKind } from "../hooks";
import { blockOf, shownRevisionOf, tracedWorkflows } from "../picture-model";
import type { RequirementDetail } from "../types";
import { Figure } from "./picture-figure";
import { PictureEditor } from "./requirement-picture-editor";
import { WorkflowPicture } from "./requirement-workflow-picture";

const BoardCanvas = dynamic(() => import("@/features/board/board-canvas"), { ssr: false });

const KINDS = ["process", "rule", "screen", "report"] as const satisfies readonly RequirementKind[];

function DrawnBy({ p }: { p: RequirementPictureView }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <span title={time.dateTime(p.writtenAt)}>
      {t("requirements.picture.drawnBy", { who: p.writtenByName ?? t("standing.who.itsAuthor") })} · {time.relative(p.writtenAt)}
    </span>
  );
}

/** The stored picture, drawn by the renderer of its kind. */
function StoredPicture({ p }: { p: RequirementPictureView }) {
  const t = useCopy();
  const by = <DrawnBy p={p} />;
  if (p.kind === "example_table") {
    const c = p.content as ExampleTableContent;
    const Table = BLOCK_RENDERERS.table;
    const fields = [
      { name: "input", type: "string" as const, label: t("requirements.picture.table.input") },
      { name: "expected", type: "string" as const, label: t("requirements.picture.table.expected") },
    ];
    const rows = c.rows.map((r) => ({ input: r.input ?? "", expected: r.expected ?? "" }));
    return (
      <Figure alt={p.alt} kind={p.kind} by={by}>
        {c.title ? <p className="text-13 font-semibold">{c.title}</p> : null}
        <Table block={blockOf("table", { columns: ["input", "expected"], frame: { fields, rows } })} />
      </Figure>
    );
  }
  if (p.kind === "wireframe") {
    const read = parseWireframe((p.content as { board: unknown }).board);
    return (
      <Figure alt={p.alt} kind={p.kind} by={by}>
        <div aria-hidden className="h-[380px] border border-line-subtle max-md:h-[300px]" data-testid="picture-board">
          {read.ok ? <BoardCanvas doc={read.doc} /> : <p className="p-4 text-13 text-muted">{read.message}</p>}
        </div>
      </Figure>
    );
  }
  const Drawn = p.kind === "chart" ? BLOCK_RENDERERS.chart : BLOCK_RENDERERS.flow;
  const spec = p.content as Record<string, unknown>;
  return (
    <Figure alt={p.alt} kind={p.kind} sample={p.kind === "chart"} by={by}>
      {typeof spec.title === "string" ? <p className="text-13 font-semibold">{spec.title}</p> : null}
      <div aria-hidden>
        <Drawn block={blockOf(p.kind === "chart" ? "chart" : "flow", spec) as never} />
      </div>
    </Figure>
  );
}

function KindSelect({ projectId, reqKey, revision, kind }: { projectId: string; reqKey: string; revision: number; kind: RequirementKind | null }) {
  const t = useCopy();
  const write = useWriteRequirementKind(projectId, reqKey);
  return (
    <div className="grid gap-1">
      <div className="w-[200px]">
        <NativeSelect
          aria-label={t("requirements.picture.edit.kind")}
          value={kind ?? ""}
          disabled={write.isPending}
          onChange={(e) => {
            const next = KINDS.find((k) => k === e.target.value) ?? null;
            write.mutate({ revision, kind: next });
          }}
          options={[{ value: "", label: t("requirements.picture.edit.kindNone") }, ...KINDS.map((k) => ({ value: k, label: t(`requirements.picture.kind.${k}`) }))]}
        />
      </div>
      <RefusalLine error={write.error} testid="kind-refusal" />
    </div>
  );
}

export function RequirementPicture({ d, projectId, slug, inset }: { d: RequirementDetail; projectId: string; slug: string; inset: string }) {
  const t = useCopy();
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const role = useProjects().data?.find((p) => p.id === projectId)?.role;
  const writer = canWriteProject(role);
  const rev = shownRevisionOf(d);
  const traced = useMemo(() => tracedWorkflows(d), [d]);
  const kind = rev?.kind ?? null;
  const picture = rev?.picture ?? null;
  const wanted = kind ? PICTURE_KIND_OF[kind] : null;
  const linked = kind === "process" && traced.length > 0;

  let body: ReactNode;
  if (linked) body = <WorkflowPicture projectId={projectId} slug={slug} traced={traced} />;
  else if (picture) body = <StoredPicture p={picture} />;
  else {
    body = (
      <p className="max-w-[80ch] border border-dashed border-line-strong px-4 py-6 text-13 text-muted" data-testid="picture-empty">
        {wanted ? t("requirements.picture.empty", { picture: t(`requirements.picture.of.${wanted}`) }) : t("requirements.picture.noKind")}
      </p>
    );
  }

  return (
    <section aria-labelledby={headingId} className={`border-b border-line-subtle py-4 ${inset}`} data-testid="requirement-picture" data-kind={kind ?? "none"}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={headingId} className="m-0 text-13 font-semibold text-fg">
          {t("requirements.picture.heading")}
        </h2>
        {kind && !writer ? <span className="text-13 text-muted">{t(`requirements.picture.kind.${kind}`)}</span> : null}
        {writer && rev ? <KindSelect projectId={projectId} reqKey={d.key} revision={rev.revision} kind={kind} /> : null}
        {writer && rev && wanted && !editing ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {t(picture ? "requirements.picture.edit.replace" : "requirements.picture.edit.draw", { picture: t(`requirements.picture.of.${wanted}`) })}
          </Button>
        ) : null}
      </div>
      {body}
      {editing && rev && wanted ? (
        <PictureEditor
          key={`${rev.revision}:${wanted}`}
          projectId={projectId}
          reqKey={d.key}
          revision={rev.revision}
          kind={wanted}
          picture={picture}
          linked={linked}
          onDone={() => setEditing(false)}
        />
      ) : null}
    </section>
  );
}
