"use client";

import { useState } from "react";
import { Button, Checkbox, Field, Input, NativeSelect, Textarea } from "@/design";
import { ecosystemApi } from "../api";
import { useApiPage, useChannelWrite, useDocument, useProjectEcosystems } from "../hooks";
import { type Refusal, readingOf, refusalsOf } from "@/lib/api/refusals";
import { type ApiPage, type DocumentType, type DocumentView, REPLY_TYPES, typeLabel } from "../types";
import { useCopy } from "@/lib/i18n/interface-language";
import { canWriteProject } from "@/features/projects";
import { useSubmitGuard } from "@/lib/utils/use-submit-guard";
import type { Role } from "./document-actions";
import { Loading, ReadOnlyNotice, RefusalNotice, UnreadNotice } from "./notices";
import { useProjectNames } from "./people";

/** The body each type carries, as a starting point to fill; core's checks decide whether it stands. */
const BODY_TEMPLATES: Record<DocumentType, Record<string, unknown>> = {
  "change-notice": {
    contract: "provider/contract",
    contractVersion: "",
    classification: "breaking",
    binding: true,
    effectiveOn: "YYYY-MM-DD",
    summary: "",
    changes: [{ element: "", kind: "changed", text: "" }],
    migration: "",
  },
  acknowledgement: { disposition: "will-adapt", adaptBy: "YYYY-MM-DD" },
  rfi: {
    question: "",
    references: [{ contract: "provider/contract", element: "" }],
    reason: "",
  },
  "change-request": {
    contract: "provider/contract",
    need: "",
    rationale: "",
    impactIfDeclined: "",
    urgency: "normal",
  },
  decision: { disposition: "answered", reason: "", answer: "" },
};

const OPENERS: DocumentType[] = ["change-notice", "rfi", "change-request"];
const OWES_DUE: DocumentType[] = ["rfi", "change-request"];

interface Form {
  type: DocumentType;
  to: string[];
  subject: string;
  dueBy: string;
  body: string;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function initialForm(opts: { draft?: DocumentView; parent?: DocumentView }): Form {
  if (opts.draft) {
    const d = opts.draft.document;
    return { type: d.type, to: d.to, subject: d.subject, dueBy: d.dueBy ?? "", body: pretty(d.body) };
  }
  if (opts.parent) {
    const type = REPLY_TYPES[opts.parent.document.type]?.[0] ?? "acknowledgement";
    return {
      type,
      to: [opts.parent.document.from],
      subject: `${opts.parent.document.number}: `,
      dueBy: "",
      body: pretty(BODY_TEMPLATES[type]),
    };
  }
  return { type: "rfi", to: [], subject: "", dueBy: "", body: pretty(BODY_TEMPLATES.rfi) };
}

/** The body as JSON, or the refusal that names why it is not. */
function parseBody(text: string): { ok: true; body: unknown } | { ok: false; refusal: Refusal } {
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch (e) {
    return {
      ok: false,
      refusal: { code: "BODY_NOT_JSON", path: "/body", detail: `the body is not JSON: ${(e as Error).message}` },
    };
  }
}

function ToField({ counterparties, to, onTo }: { counterparties: { id: string; name: string }[]; to: string[]; onTo: (to: string[]) => void }) {
  const t = useCopy();
  return (
    <fieldset className="space-y-1">
      <legend className="fg-label text-fg">{t("ecosystem.compose.to")}</legend>
      {counterparties.length === 0 ? (
        <p className="fg-caption">{t("ecosystem.compose.noCounterparty")}</p>
      ) : (
        counterparties.map((p) => (
          <Checkbox
            key={p.id}
            label={p.name}
            checked={to.includes(p.id)}
            onChange={(on) => onTo(on ? [...to, p.id] : to.filter((x) => x !== p.id))}
          />
        ))
      )}
    </fieldset>
  );
}

interface ComposeProps {
  projectId: string;
  slug: string;
  ecosystem: string;
  draft?: DocumentView;
  parent?: DocumentView;
  counterparties: { id: string; name: string }[];
  onSaved: (view: DocumentView) => void;
}

function useComposeSave({ projectId, ecosystem, draft, onSaved }: ComposeProps, form: Form, inReplyTo: string | undefined) {
  const [local, setLocal] = useState<Refusal | null>(null);
  const submitting = useSubmitGuard();
  const save = useChannelWrite((input: Parameters<typeof ecosystemApi.draft>[2]) =>
    draft ? ecosystemApi.edit(projectId, draft.id, input) : ecosystemApi.draft(projectId, ecosystem, input),
  );
  const submit = () => {
    const body = parseBody(form.body);
    if (!body.ok) {
      setLocal(body.refusal);
      return;
    }
    setLocal(null);
    if (!submitting.claim()) return;
    save.mutate(
      {
        type: form.type,
        to: form.to,
        subject: form.subject,
        ...(form.dueBy ? { dueBy: form.dueBy } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
        body: body.body,
      },
      { onSuccess: onSaved, onSettled: submitting.release },
    );
  };
  return { save, submit, local };
}

function ComposeForm(props: ComposeProps) {
  const t = useCopy();
  const { draft, parent, counterparties } = props;
  const [form, setForm] = useState<Form>(() => initialForm({ draft, parent }));
  const types = parent ? (REPLY_TYPES[parent.document.type] ?? []) : draft ? [draft.document.type] : OPENERS;
  const inReplyTo = parent?.document.number ?? draft?.document.inReplyTo ?? undefined;
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const { save, submit, local } = useComposeSave(props, form, inReplyTo);
  return (
    <form
      className="max-w-2xl space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label={t("ecosystem.compose.type")} htmlFor="doc-type">
        <NativeSelect
          id="doc-type"
          value={form.type}
          disabled={types.length < 2}
          onChange={(e) => {
            const type = e.target.value as DocumentType;
            set({ type, body: pretty(BODY_TEMPLATES[type]) });
          }}
          options={types.map((type) => ({ value: type, label: typeLabel(type, t) }))}
        />
      </Field>
      {inReplyTo ? <p className="fg-caption">{t("ecosystem.compose.inReplyTo", { ref: inReplyTo })}</p> : null}
      <ToField counterparties={counterparties} to={form.to} onTo={(to) => set({ to })} />
      <Field label={t("ecosystem.compose.subject")} htmlFor="doc-subject">
        <Input id="doc-subject" value={form.subject} onChange={(e) => set({ subject: e.target.value })} />
      </Field>
      <Field
        label={t("ecosystem.compose.dueBy")}
        htmlFor="doc-due"
        hint={OWES_DUE.includes(form.type) ? t("ecosystem.compose.required") : t("ecosystem.compose.optional")}
      >
        <Input id="doc-due" type="date" value={form.dueBy} onChange={(e) => set({ dueBy: e.target.value })} />
      </Field>
      <Field label={t("ecosystem.compose.body")} htmlFor="doc-body">
        <Textarea
          id="doc-body"
          rows={14}
          className="font-mono text-12"
          value={form.body}
          onChange={(e) => set({ body: e.target.value })}
        />
      </Field>
      {local ? <RefusalNotice refusals={[local]} /> : null}
      {save.isError ? <RefusalNotice refusals={refusalsOf(save.error)} /> : null}
      <Button type="submit" variant="primary" loading={save.isPending}>
        {draft ? t("ecosystem.compose.saveDraft") : t("ecosystem.compose.saveAsDraft")}
      </Button>
    </form>
  );
}

/** Who a document in `ecosystem` can go to: the API page's providers and consumers there, the parent's sender, the draft's recipients. */
function counterpartiesOf(
  page: ApiPage,
  ecosystem: string,
  parent: DocumentView | undefined,
  draft: DocumentView | undefined,
): string[] {
  const ids = new Set<string>();
  for (const c of page.consumes) if (c.ecosystem === ecosystem && c.provider) ids.add(c.provider.id);
  for (const p of page.publishes)
    for (const c of p.consumers) if (c.ecosystem === ecosystem && c.project) ids.add(c.project.id);
  if (parent) ids.add(parent.document.from);
  for (const t of draft?.document.to ?? []) ids.add(t);
  return [...ids];
}

export function ComposeScreen({
  projectId,
  slug,
  role,
  params,
  onSaved,
}: {
  projectId: string;
  slug: string;
  role: Role;
  params: { ecosystem?: string; inReplyTo?: string; draft?: string };
  onSaved: (view: DocumentView) => void;
}) {
  const t = useCopy();
  const names = useProjectNames(projectId);
  const parentR = readingOf(useDocument(projectId, params.inReplyTo));
  const draftR = readingOf(useDocument(projectId, params.draft));
  const ecosR = readingOf(useProjectEcosystems(projectId));
  const pageR = readingOf(useApiPage(projectId));

  if (!canWriteProject(role)) {
    return <ReadOnlyNotice role={role} slug={slug} />;
  }
  for (const [what, r, wanted] of [
    [t("ecosystem.doc.unread", { ref: params.inReplyTo ?? "" }), parentR, params.inReplyTo],
    [t("ecosystem.compose.draftWhat", { ref: params.draft ?? "" }), draftR, params.draft],
  ] as const) {
    if (!wanted) continue;
    if (r.kind === "loading") return <Loading what={what} />;
    if (r.kind === "unread") return <UnreadNotice what={what} refusals={r.refusals} />;
  }
  if (ecosR.kind === "loading" || pageR.kind === "loading") return <Loading what={t("ecosystem.compose.counterpartiesWhat")} />;
  if (ecosR.kind === "unread") return <UnreadNotice what={t("ecosystem.compose.ecosystemsWhat")} refusals={ecosR.refusals} />;
  if (pageR.kind === "unread") return <UnreadNotice what={t("ecosystem.api.what", { slug })} refusals={pageR.refusals} />;

  const parent = parentR.kind === "read" ? parentR.value : undefined;
  const draft = draftR.kind === "read" ? draftR.value : undefined;
  const active = ecosR.value.memberships.filter((m) => m.document.state === "active" && m.ecosystem);
  const ecosystem =
    draft?.document.ecosystem ?? parent?.document.ecosystem ?? params.ecosystem ?? active[0]?.ecosystem?.id;
  if (!ecosystem || !active.some((m) => m.ecosystem?.id === ecosystem)) {
    return (
      <RefusalNotice
        title={t("ecosystem.compose.writeRefused")}
        refusals={[
          {
            code: "ECOSYSTEM_NOT_MEMBER",
            path: "/ecosystem",
            detail: ecosystem
              ? t("ecosystem.compose.notMemberOf", { slug, ecosystem })
              : t("ecosystem.compose.notMemberAny", { slug }),
          },
        ]}
      />
    );
  }
  const counterparties = counterpartiesOf(pageR.value, ecosystem, parent, draft).map((id) => ({ id, name: names(id) }));

  return (
    <ComposeForm
      projectId={projectId}
      slug={slug}
      ecosystem={ecosystem}
      draft={draft}
      parent={parent}
      counterparties={counterparties}
      onSaved={onSaved}
    />
  );
}
