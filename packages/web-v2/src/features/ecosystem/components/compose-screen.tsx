"use client";

import { useState } from "react";
import { Button, Checkbox, Field, Input, NativeSelect, Textarea } from "@/design";
import { ecosystemApi } from "../api";
import { useApiPage, useChannelWrite, useDocument, useProjectEcosystems } from "../hooks";
import { type Refusal, readingOf, refusalsOf } from "@/lib/api/refusals";
import { type DocumentType, type DocumentView, REPLY_TYPES } from "../types";
import { canWriteProject } from "@/features/projects/write-access";
import type { Role } from "./document-actions";
import { Loading, ReadOnlyNotice, RefusalNotice, UnreadNotice } from "./notices";
import { useProjectNames } from "./people";
import { TYPE_LABEL } from "./register-screen";

/** The body each type carries, as a starting point to fill; core's checks decide whether it stands. */
export const BODY_TEMPLATES: Record<DocumentType, Record<string, unknown>> = {
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
export function parseBody(text: string): { ok: true; body: unknown } | { ok: false; refusal: Refusal } {
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch (e) {
    return {
      ok: false,
      refusal: { code: "BODY_NOT_JSON", path: "/body", detail: `the body is not JSON: ${(e as Error).message}` },
    };
  }
}

function ComposeForm({
  projectId,
  slug,
  ecosystem,
  draft,
  parent,
  counterparties,
  onSaved,
}: {
  projectId: string;
  slug: string;
  ecosystem: string;
  draft?: DocumentView;
  parent?: DocumentView;
  counterparties: { id: string; name: string }[];
  onSaved: (view: DocumentView) => void;
}) {
  const [form, setForm] = useState<Form>(() => initialForm({ draft, parent }));
  const [local, setLocal] = useState<Refusal | null>(null);
  const save = useChannelWrite((input: Parameters<typeof ecosystemApi.draft>[2]) =>
    draft ? ecosystemApi.edit(projectId, draft.id, input) : ecosystemApi.draft(projectId, ecosystem, input),
  );
  const types = parent ? (REPLY_TYPES[parent.document.type] ?? []) : draft ? [draft.document.type] : OPENERS;
  const inReplyTo = parent?.document.number ?? draft?.document.inReplyTo ?? undefined;
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const submit = () => {
    const body = parseBody(form.body);
    if (!body.ok) {
      setLocal(body.refusal);
      return;
    }
    setLocal(null);
    save.mutate(
      {
        type: form.type,
        to: form.to,
        subject: form.subject,
        ...(form.dueBy ? { dueBy: form.dueBy } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
        body: body.body,
      },
      { onSuccess: onSaved },
    );
  };

  return (
    <form
      className="max-w-2xl space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="Type" htmlFor="doc-type">
        <NativeSelect
          id="doc-type"
          value={form.type}
          disabled={types.length < 2}
          onChange={(e) => {
            const type = e.target.value as DocumentType;
            set({ type, body: pretty(BODY_TEMPLATES[type]) });
          }}
          options={types.map((t) => ({ value: t, label: TYPE_LABEL[t] ?? t }))}
        />
      </Field>
      {inReplyTo ? <p className="fg-caption">In reply to {inReplyTo}</p> : null}
      <fieldset className="space-y-1">
        <legend className="fg-label text-fg">To</legend>
        {counterparties.length === 0 ? (
          <p className="fg-caption">
            {slug} has no counterparty in this ecosystem: a document goes only to a project it publishes to or consumes from.
          </p>
        ) : (
          counterparties.map((p) => (
            <Checkbox
              key={p.id}
              label={p.name}
              checked={form.to.includes(p.id)}
              onChange={(on) => set({ to: on ? [...form.to, p.id] : form.to.filter((t) => t !== p.id) })}
            />
          ))
        )}
      </fieldset>
      <Field label="Subject" htmlFor="doc-subject" hint="8 to 160 characters, in English: the other side may be another org.">
        <Input id="doc-subject" value={form.subject} onChange={(e) => set({ subject: e.target.value })} />
      </Field>
      <Field
        label="Due by"
        htmlFor="doc-due"
        hint={OWES_DUE.includes(form.type) ? "Required: the reply is owed by this date." : "Optional."}
      >
        <Input id="doc-due" type="date" value={form.dueBy} onChange={(e) => set({ dueBy: e.target.value })} />
      </Field>
      <Field label="Body" htmlFor="doc-body" hint="JSON in the shape of this type; core's checks name anything that does not stand.">
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
        {draft ? "Save the draft" : "Save as draft"}
      </Button>
      <p className="fg-caption">Saving keeps it on this side; submit it from the document page to send it.</p>
    </form>
  );
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
  const names = useProjectNames(projectId);
  const parentR = readingOf(useDocument(projectId, params.inReplyTo));
  const draftR = readingOf(useDocument(projectId, params.draft));
  const ecosR = readingOf(useProjectEcosystems(projectId));
  const pageR = readingOf(useApiPage(projectId));

  if (!canWriteProject(role)) {
    return <ReadOnlyNotice role={role} slug={slug} writes="drafts and replies" />;
  }
  for (const [what, r, wanted] of [
    [`Document ${params.inReplyTo}`, parentR, params.inReplyTo],
    [`Draft ${params.draft}`, draftR, params.draft],
  ] as const) {
    if (!wanted) continue;
    if (r.kind === "loading") return <Loading what={what} />;
    if (r.kind === "unread") return <UnreadNotice what={what} refusals={r.refusals} />;
  }
  if (ecosR.kind === "loading" || pageR.kind === "loading") return <Loading what="this project's counterparties" />;
  if (ecosR.kind === "unread") return <UnreadNotice what="This project's ecosystems" refusals={ecosR.refusals} />;
  if (pageR.kind === "unread") return <UnreadNotice what="This project's API page" refusals={pageR.refusals} />;

  const parent = parentR.kind === "read" ? parentR.value : undefined;
  const draft = draftR.kind === "read" ? draftR.value : undefined;
  const active = ecosR.value.memberships.filter((m) => m.document.state === "active" && m.ecosystem);
  const ecosystem =
    draft?.document.ecosystem ?? parent?.document.ecosystem ?? params.ecosystem ?? active[0]?.ecosystem?.id;
  if (!ecosystem || !active.some((m) => m.ecosystem?.id === ecosystem)) {
    return (
      <RefusalNotice
        title="No channel to write in"
        refusals={[
          {
            code: "ECOSYSTEM_NOT_MEMBER",
            path: "/ecosystem",
            detail: ecosystem
              ? `${slug} is not an active member of ecosystem ${ecosystem}.`
              : `${slug} is an active member of no ecosystem.`,
          },
        ]}
      />
    );
  }
  const page = pageR.value;
  const ids = new Set<string>();
  for (const c of page.consumes) if (c.ecosystem === ecosystem && c.provider) ids.add(c.provider.id);
  for (const p of page.publishes)
    for (const c of p.consumers) if (c.ecosystem === ecosystem && c.project) ids.add(c.project.id);
  if (parent) ids.add(parent.document.from);
  for (const t of draft?.document.to ?? []) ids.add(t);
  const counterparties = [...ids].map((id) => ({ id, name: names(id) }));

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
