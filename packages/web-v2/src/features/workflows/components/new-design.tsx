// A design started by hand: its title and summary and the template it is drawn in. It starts from the
// template's own example, whose shape the template's rules already hold, or — for a template with none
// — from a first step written here (`design-draft.ts:newDesign`). Core writes it as a draft
// (`createWorkflow`), and its page opens on the Edit view, where its steps are made its own and from
// where it is proposed. The flow it is filed under is read from the title.

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { useState } from "react";
import { Button, Dialog, Field, Input, Select, Textarea } from "@/design";
import { placeRefusals } from "@/lib/api/field-refusals";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import { workflowHref } from "@/lib/routes/workflows";
import { templateTitle } from "../catalogue";
import { type DesignStart, firstTypeOf, flowOf, newDesign, nodeFieldsOf, withNodeField } from "../design-draft";
import { useCreateDesign, useTemplateExample } from "../hooks";
import type { WorkflowStep } from "../types";
import { DesignField } from "./design-fields";

const FIELDS = {
  title: ["/title", "/flow"],
  summary: ["/summary"],
  template: ["/template", "/kind"],
  step: ["/steps"],
} as const;

function NewDesignForm({ projectId, slug, templates, onDone }: { projectId: string; slug: string; templates: readonly WorkflowTemplate[]; onDone: () => void }) {
  const t = useCopy();
  const label = useLabel();
  const router = useRouter();
  const create = useCreateDesign(projectId);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [templateKey, setTemplateKey] = useState(templates[0] ? `${templates[0].id}@${templates[0].version}` : "");
  const template = templates.find((x) => `${x.id}@${x.version}` === templateKey) ?? null;
  const [first, setFirst] = useState<WorkflowStep>(() => ({
    id: "",
    does: "",
    after: [],
    node: { type: template ? firstTypeOf(template) : "STEP" },
  }));
  const example = useTemplateExample(projectId, template);
  const refused = placeRefusals(create.error, FIELDS);
  const flow = flowOf(title);
  const type = first.node?.type ?? "";
  const start: DesignStart | null = example.data ? { example: example.data } : example.isSuccess ? { first: { does: first.does, node: { ...first.node, type } } } : null;
  const firstReady = start !== null && ("example" in start || (first.does.trim() && first.node?.label?.trim()));
  const ready = title.trim() && summary.trim() && template && firstReady;
  return (
    <form
      className="grid gap-3"
      data-testid="new-design-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!template || !start) return;
        create.mutate(newDesign({ projectId, flow, title, summary, template, start }), {
          onSuccess: () => {
            onDone();
            router.push(`${workflowHref(slug, flow)}?tab=edit`);
          },
        });
      }}
    >
      <Field label={t("workflows.edit.title")} required error={refused.at("title")}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </Field>
      <Field label={t("workflows.edit.summary")} required error={refused.at("summary")}>
        <Textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={400} />
      </Field>
      <Field label={t("workflows.diagramType")} required error={refused.at("template")}>
        <Select
          options={templates.map((x) => ({
            value: `${x.id}@${x.version}`,
            label: templateTitle(x.id, templates, label),
          }))}
          value={templateKey}
          onChange={(key) => {
            setTemplateKey(key);
            const next = templates.find((x) => `${x.id}@${x.version}` === key);
            // a new template has types of its own: the step keeps its words and takes the new template's first type
            if (next)
              setFirst({
                ...first,
                node: {
                  type: firstTypeOf(next),
                  ...(first.node?.label ? { label: first.node.label } : {}),
                },
              });
          }}
        />
      </Field>
      {example.data ? (
        <p className="text-13 text-muted" data-testid="new-design-from-example">
          {t("workflows.edit.fromExample", { n: example.data.steps.length })}
        </p>
      ) : null}
      {example.isSuccess && !example.data ? (
        <fieldset className="grid gap-3 border-t border-line-subtle pt-3" data-testid="new-design-first-step">
          <legend className="fg-label pr-2">{t("workflows.edit.firstStep")}</legend>
          <Field label={t("workflows.edit.stepLabel")} required error={refused.at("step")}>
            <Input value={first.node?.label ?? ""} onChange={(e) => setFirst(withNodeField(first, "label", e.target.value))} maxLength={60} />
          </Field>
          <Field label={t("workflows.edit.does")} required>
            <Textarea rows={2} value={first.does} onChange={(e) => setFirst({ ...first, does: e.target.value })} maxLength={600} />
          </Field>
          <Field label={t("workflows.panel.kind")}>
            <Select
              options={(template?.nodeTypes ?? []).map((x) => ({
                value: x.id,
                label: x.label,
              }))}
              value={type}
              onChange={(next) => setFirst(withNodeField(first, "type", next))}
            />
          </Field>
          {nodeFieldsOf(template, type).map((field) => (
            <DesignField
              key={field}
              field={field}
              value={(first.node as Record<string, unknown> | undefined)?.[field]}
              onChange={(v) => setFirst(withNodeField(first, field, v))}
              personas={[]}
              error={undefined}
            />
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" variant="primary" loading={create.isPending} disabled={!ready}>
          {t("workflows.edit.create")}
        </Button>
      </div>
      <RefusalLine error={example.error} testid="new-design-example-refusal" />
      <RefusalLine error={create.error} onField={refused.onField} testid="new-design-refusal" />
    </form>
  );
}

/** "New design": the button and the dialog it opens. */
export function NewDesign({ projectId, slug, templates }: { projectId: string; slug: string; templates: readonly WorkflowTemplate[] }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" icon="plus" onClick={() => setOpen(true)} data-testid="new-design">
        {t("workflows.edit.newDesign")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={t("workflows.edit.newDesign")} width="lg" testId="new-design-dialog">
        {open ? <NewDesignForm projectId={projectId} slug={slug} templates={templates} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  );
}
