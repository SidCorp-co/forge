// The Edit view of a design: its title and summary, its own lanes or personas where its template asks
// for them, every step and every line, written in place and saved whole over the revision it was read
// at. Where the design stands sits on top: its approval, its revision, and what a save does to it — a
// draft stays a draft until it is proposed; any other design goes to its approver by the save itself
// (`workflows/design.ts:designStatusAfterWrite`). Whom it waits on is the banner's, above the tabs.

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { useState } from "react";
import { Button, Field, IconButton, Input, Textarea, useListKeys, ViewHeading } from "@/design";
import { type IssuePick, IssuePicker } from "@/features/issue-picker";
import { RefusalLine } from "@/lib/api/refusal-line";
import { namedRefusals } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import {
  addedEdge,
  addedStep,
  bandsOf,
  declaresPersonas,
  documentOf,
  lanesFromDesign,
  nextTypeOf,
  refusalsUnder,
  removedEdge,
  removedStep,
  withEdge,
  withStep,
} from "../design-draft";
import { useProposeDesign, useWriteDesign } from "../hooks";
import type { DesignDocument, WorkflowDesign, WorkflowRecord } from "../types";
import { LineEditor, StepEditor } from "./design-step-editor";
import { WithdrawDesign } from "./design-withdraw";
import { DesignPill } from "./workflow-parts";

type Named = { id: string; label: string };

/** A design's own lanes or personas: each a label, its id minted once and kept. */
function NamedRows({ title, rows, onChange, error, prefix }: { title: string; rows: Named[]; onChange: (rows: Named[]) => void; error: string | undefined; prefix: string }) {
  const t = useCopy();
  const keys = useListKeys(rows.length);
  return (
    <Field label={title} error={error}>
      <div className="grid gap-1.5" data-testid={`named-${prefix}`}>
        {rows.map((r, i) => (
          <span key={keys.keys[i]} className="flex items-center gap-1.5">
            <Input aria-label={t("workflows.edit.nameN", { what: title, n: i + 1 })} value={r.label} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} maxLength={60} />
            <IconButton
              icon="x"
              size="sm"
              aria-label={t("workflows.edit.removeNamed", { name: r.label || r.id })}
              onClick={() => {
                keys.removed(i);
                onChange(rows.filter((_, j) => j !== i));
              }}
            />
          </span>
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon="plus"
          className="w-fit"
          onClick={() => {
            const taken = new Set(rows.map((r) => r.id));
            let n = rows.length + 1;
            while (taken.has(`${prefix}-${n}`)) n += 1;
            keys.added();
            onChange([...rows, { id: `${prefix}-${n}`, label: "" }]);
          }}
        >
          {t("workflows.edit.addNamed", { what: title })}
        </Button>
      </div>
    </Field>
  );
}

/** What a save does to this design, said before it is pressed. */
function DesignStanding({ d, record, dirty }: { d: WorkflowDesign; record: WorkflowRecord; dirty: boolean }) {
  const t = useCopy();
  const drafting = d.status === "draft" || d.status === null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-13" data-testid="design-edit-standing" data-status={d.status ?? "none"}>
      {d.status ? <DesignPill status={d.status} /> : null}
      <span className="font-mono text-12 text-muted">{t("workflows.edit.atRevision", { r: record.revision })}</span>
      <span className="text-muted">·</span>
      <span>{drafting ? t("workflows.edit.saveKeepsDraft") : t("workflows.edit.saveProposes")}</span>
      {dirty ? <span className="font-semibold text-accent-text">{t("workflows.edit.unsaved")}</span> : null}
    </p>
  );
}

export function DesignEditor({ projectId, slug, d, record, template }: { projectId: string; slug: string; d: WorkflowDesign; record: WorkflowRecord; template: WorkflowTemplate | null }) {
  const t = useCopy();
  const start = documentOf(record.document);
  const [doc, setDoc] = useState<DesignDocument>(start);
  const [issue, setIssue] = useState<IssuePick[]>([]);
  const save = useWriteDesign(projectId, record.document.id);
  const propose = useProposeDesign(projectId, record.document.id);
  const refusals = namedRefusals(save.error);
  const at = (path: string) => refusalsUnder(refusals, path);
  const dirty = JSON.stringify(doc) !== JSON.stringify(start);
  const drafting = d.status === "draft" || d.status === null;
  const bands = bandsOf(template, doc);
  const personas = doc.personas ?? [];
  const onField = (r: { path: string }) => ["/title", "/summary", "/lanes", "/personas", "/steps", "/edges"].some((p) => r.path === p || r.path.startsWith(`${p}/`));
  const edges = doc.edges ?? [];
  const lineKeys = useListKeys(edges.length);
  const drawnUnder = issue[0]?.key;
  return (
    <form
      className="grid max-w-4xl gap-5"
      data-testid="design-editor"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ baseRevision: record.revision, document: doc, issue: drawnUnder });
      }}
    >
      <DesignStanding d={d} record={record} dirty={dirty} />
      <section className="grid gap-3">
        <Field label={t("workflows.edit.title")} required error={at("/title").rest([])}>
          <Input value={doc.title} onChange={(e) => setDoc({ ...doc, title: e.target.value })} maxLength={120} />
        </Field>
        <Field label={t("workflows.edit.summary")} required error={at("/summary").rest([])}>
          <Textarea rows={2} value={doc.summary} onChange={(e) => setDoc({ ...doc, summary: e.target.value })} maxLength={400} />
        </Field>
        {lanesFromDesign(template) ? <NamedRows title={t("workflows.edit.lanes")} prefix="lane" rows={doc.lanes ?? []} onChange={(lanes) => setDoc({ ...doc, lanes })} error={at("/lanes").rest([])} /> : null}
        {declaresPersonas(template) ? <NamedRows title={t("workflows.edit.personas")} prefix="persona" rows={personas} onChange={(p) => setDoc({ ...doc, personas: p })} error={at("/personas").rest([])} /> : null}
      </section>

      <section data-testid="design-edit-steps">
        <ViewHeading>{doc.kind === "state" ? t("workflows.tab.states") : t("workflows.tab.steps")}</ViewHeading>
        <StepsAt refusals={refusals} path="/steps" count={doc.steps.length} />
        <ol className="border-t border-line-subtle">
          {doc.steps.map((s, i) => (
            <StepEditor
              key={s.id}
              step={s}
              n={i + 1}
              steps={doc.steps}
              template={template}
              bands={bands}
              personas={personas}
              errors={at(`/steps/${i}`)}
              onChange={(next) => setDoc(withStep(doc, i, next))}
              onRemove={() => setDoc(removedStep(doc, s.id))}
            />
          ))}
        </ol>
        <Button type="button" size="sm" variant="ghost" icon="plus" className="mt-2" onClick={() => setDoc(addedStep(doc, t("workflows.edit.newStep"), template ? nextTypeOf(template) : "STEP"))}>
          {t("workflows.edit.addStep")}
        </Button>
      </section>

      <section data-testid="design-edit-lines">
        <ViewHeading>{t("workflows.edit.lines")}</ViewHeading>
        <StepsAt refusals={refusals} path="/edges" count={edges.length} />
        <ol className="border-t border-line-subtle">
          {edges.map((e, i) => (
            <LineEditor
              key={lineKeys.keys[i]}
              edge={e}
              n={i + 1}
              steps={doc.steps}
              template={template}
              errors={at(`/edges/${i}`)}
              onChange={(next) => setDoc(withEdge(doc, i, next))}
              onRemove={() => {
                lineKeys.removed(i);
                setDoc(removedEdge(doc, i));
              }}
            />
          ))}
        </ol>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon="plus"
          className="mt-2"
          disabled={doc.steps.length === 0}
          onClick={() => {
            lineKeys.added();
            setDoc(addedEdge(doc));
          }}
        >
          {t("workflows.edit.addLine")}
        </Button>
      </section>

      <section className="sticky bottom-0 grid gap-2 border-t border-line-subtle bg-app py-3" data-testid="design-edit-acts">
        <Field label={t("workflows.edit.drawnUnder")}>
          <IssuePicker projectId={projectId} value={issue} onChange={setIssue} ariaLabel={t("workflows.edit.drawnUnder")} single />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" variant={drafting ? "secondary" : "primary"} loading={save.isPending} disabled={!dirty}>
            {drafting ? t("workflows.edit.save") : t("workflows.edit.saveAndPropose")}
          </Button>
          {drafting ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              loading={propose.isPending}
              disabled={dirty}
              title={dirty ? t("workflows.edit.saveFirst") : undefined}
              onClick={() => propose.mutate({ revision: record.revision, issue: drawnUnder })}
              data-testid="design-propose"
            >
              {t("workflows.edit.propose", { r: record.revision })}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" disabled={!dirty || save.isPending} onClick={() => setDoc(start)}>
            {t("workflows.edit.discard")}
          </Button>
          <span className="ml-auto">
            <WithdrawDesign projectId={projectId} slug={slug} d={d} />
          </span>
        </div>
        <RefusalLine error={save.error} onField={onField} testid="design-save-refusal" />
        <RefusalLine error={propose.error} testid="design-propose-refusal" />
      </section>
    </form>
  );
}

/** A refusal at the list itself (`/steps`, `/edges`), not at one of its items. */
function StepsAt({ refusals, path, count }: { refusals: readonly { path: string; detail: string }[]; path: string; count: number }) {
  const words = refusalsUnder(refusals, path).rest(Array.from({ length: count }, (_, i) => String(i)));
  if (!words) return null;
  return (
    <p role="alert" className="mb-2 text-12 text-danger-11">
      {words}
    </p>
  );
}
