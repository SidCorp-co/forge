// A revision written by hand: a new draft opened on the agreed head with the reason it is opened for,
// or the open draft edited in place. Only a draft is ever written; the head and a proposal stand as
// they are (core refuses anything else by name, REQUIREMENT_REVISION_NOT_DRAFT). A refused save shows
// core's words on the field, or the criterion, its path names (REQ-34 BC-18).

import { useState } from "react";
import { Button, Field, focusOnMount, Input, Textarea } from "@/design";
import { placeRefusals } from "@/lib/api/field-refusals";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { type RevisionTarget, useWriteRevision } from "../hooks";
import { criterionHasWords, type RevisionDraft, revisionDraftOf, revisionWrite } from "../revision-draft";
import type { RequirementDetail, RequirementRevision } from "../types";
import { CriteriaEditor } from "./criteria-editor";

const MAX_CRITERIA = 200;

/** The form's fields and each criterion by index, so a refusal at `/criteria/2/body` lands on the third. */
function fieldsFor(count: number) {
  const criteria = Object.fromEntries(Array.from({ length: Math.min(count, MAX_CRITERIA) }, (_, i) => [`c${i}`, [`/criteria/${i}`]]));
  return { reason: ["/reason"], tldr: ["/tldr"], changeSummary: ["/changeSummary"], ...criteria, criteria: ["/criteria"] } as Record<string, readonly string[]>;
}

function RevisionForm({
  projectId,
  d,
  target,
  start,
  held,
  submit,
  onDone,
}: {
  projectId: string;
  d: RequirementDetail;
  target: RevisionTarget;
  start: RevisionDraft;
  /** The revision the write keeps the language of: the draft edited, or none for a new one. */
  held: RequirementRevision | null;
  submit: string;
  onDone: () => void;
}) {
  const t = useCopy();
  const [draft, setDraft] = useState(start);
  const save = useWriteRevision(projectId, d.key, target);
  const refused = placeRefusals(save.error, fieldsFor(draft.criteria.length));
  const fresh = target.kind === "new";
  const ready = draft.criteria.some(criterionHasWords) && (!fresh || draft.reason.trim().length > 0);
  const set = (patch: Partial<RevisionDraft>) => setDraft({ ...draft, ...patch });
  return (
    <form
      className="grid max-w-3xl gap-3"
      data-testid="revision-form"
      data-target={target.kind}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(revisionWrite(draft, held), { onSuccess: onDone });
      }}
    >
      <Field label={t("requirements.revise.reason")} required={fresh} error={refused.at("reason")}>
        <Textarea rows={2} value={draft.reason} onChange={(e) => set({ reason: e.target.value })} ref={fresh ? focusOnMount : undefined} />
      </Field>
      <Field label={t("requirements.revise.summary")} error={refused.at("tldr")}>
        <Input value={draft.tldr} onChange={(e) => set({ tldr: e.target.value })} maxLength={4000} />
      </Field>
      <Field label={t("requirements.revise.changeSummary")} error={refused.at("changeSummary")}>
        <Input value={draft.changeSummary} onChange={(e) => set({ changeSummary: e.target.value })} maxLength={4000} />
      </Field>
      <section aria-label={t("requirements.revise.criteria")}>
        <h3 className="fg-label mb-1">{t("requirements.revise.criteria")}</h3>
        <CriteriaEditor rows={draft.criteria} onChange={(criteria) => set({ criteria })} errorAt={(i) => refused.at(`c${i}`) ?? (i === 0 ? refused.at("criteria") : undefined)} />
      </section>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={save.isPending} disabled={!ready}>
          {submit}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
      <RefusalLine error={save.error} onField={refused.onField} testid="revision-refusal" />
    </form>
  );
}

/** "New revision" on a requirement with a head and nothing open: the form opens on the head's criteria. */
export function NewRevision({ projectId, d }: { projectId: string; d: RequirementDetail }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const head = d.revisions.find((r) => r.state === "current") ?? null;
  if (!open) {
    return (
      <Button type="button" size="sm" icon="plus" onClick={() => setOpen(true)} data-testid="revision-new">
        {t("requirements.revise.new")}
      </Button>
    );
  }
  return (
    <section className="grid basis-full gap-2" data-testid="revision-new-form">
      <h3 className="fg-h3">{t("requirements.revise.newOn", { r: d.currentRevision ?? "—" })}</h3>
      <RevisionForm
        projectId={projectId}
        d={d}
        target={{ kind: "new", baseRevision: d.currentRevision }}
        start={revisionDraftOf(head, true)}
        held={null}
        submit={t("requirements.revise.openDraft")}
        onDone={() => setOpen(false)}
      />
    </section>
  );
}

/** "Edit draft" on the open draft: the whole revision rewritten from the form. */
export function DraftRevisionEditor({ projectId, d, draft }: { projectId: string; d: RequirementDetail; draft: RequirementRevision }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  if (draft.state !== "draft") return null;
  if (!open) {
    return (
      <Button type="button" size="sm" icon="rename" onClick={() => setOpen(true)} data-testid="revision-edit">
        {t("requirements.revise.edit", { r: draft.revision })}
      </Button>
    );
  }
  return (
    <RevisionForm
      key={draft.revision}
      projectId={projectId}
      d={d}
      target={{ kind: "draft", revision: draft.revision }}
      start={revisionDraftOf(draft, false)}
      held={draft}
      submit={t("requirements.revise.save")}
      onDone={() => setOpen(false)}
    />
  );
}
