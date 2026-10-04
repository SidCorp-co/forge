"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input, NativeSelect } from "@/design";
import { useOrgs } from "@/features/orgs/hooks";
import { useProjects } from "@/features/projects/hooks";
import { readingOf, refusalsOf, type Refusal } from "@/lib/api/refusals";
import { ecosystemApi } from "../api";
import { useChannelWrite, useEcosystemDocument } from "../hooks";
import { ecosystemRoutes } from "../routes";
import {
  DOCUMENT_TYPES,
  type EcosystemDocument,
  type GateMode,
  type HeldEcosystem,
  type ReplyWindowType,
  TYPE_LABEL,
} from "../types";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";

// cm:edge contract -> packages/core/src/ecosystem/schema.ts:ecosystemDocumentSchema — the form writes ecosystem-v1 whole, so a field core adds or renames there changes here
const SCHEMA = "https://forge.sidcorp.co/schemas/ecosystem-v1.json";
const WINDOWS: ReplyWindowType[] = ["rfi", "change-request", "change-notice"];

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 63);

const BLANK: EcosystemDocument = {
  $schema: SCHEMA,
  version: 1,
  ecosystem: { slug: "", name: "", steward: "" },
  channel: { code: "", responseDays: { rfi: 3, "change-request": 5, "change-notice": 7 } },
  gate: { "change-notice": "publish", acknowledgement: "publish", rfi: "publish", "change-request": "approve", decision: "publish" },
  visibility: { members: "counterparties" },
};

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child every caller passes in
  <label className="grid gap-1">
    <span className="text-12-5 font-semibold">{label}</span>
    {children}
    {hint ? <span className="text-12 text-subtle">{hint}</span> : null}
  </label>
);

type Patch = (patch: (d: EcosystemDocument) => EcosystemDocument) => void;

function ReplyWindowsField({ doc, set }: { doc: EcosystemDocument; set: Patch }) {
  return (
    <Field label="Reply windows" hint="Days a recipient has to reply">
      <span className="flex flex-wrap gap-3.5 rounded-md border border-line px-2.5 py-1.5 text-13">
        {WINDOWS.map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            {TYPE_LABEL[t]}
            <input
              type="number"
              min={1}
              max={90}
              aria-label={`${TYPE_LABEL[t]} reply window in days`}
              className="w-12 rounded border border-line bg-surface px-1 text-center font-semibold"
              value={doc.channel.responseDays[t]}
              onChange={(e) =>
                set((d) => ({ ...d, channel: { ...d.channel, responseDays: { ...d.channel.responseDays, [t]: Number(e.target.value) } } }))
              }
            />
            days
          </span>
        ))}
      </span>
    </Field>
  );
}

function GateField({ doc, set }: { doc: EcosystemDocument; set: Patch }) {
  return (
    <Field label="Before a document is sent">
      <span className="grid gap-1 rounded-md border border-line px-2.5 py-1.5 text-13">
        {DOCUMENT_TYPES.map((t) => (
          <span key={t} className="flex items-center justify-between gap-2">
            {TYPE_LABEL[t]}
            <select
              aria-label={`${TYPE_LABEL[t]}: before it is sent`}
              className="rounded border border-line bg-surface px-1 font-semibold"
              value={doc.gate[t]}
              onChange={(e) => set((d) => ({ ...d, gate: { ...d.gate, [t]: e.target.value as GateMode } }))}
            >
              <option value="publish">send at once</option>
              <option value="approve">an admin approves</option>
            </select>
          </span>
        ))}
      </span>
    </Field>
  );
}

function MembersField({
  label,
  members,
  setMembers,
  projects,
}: {
  label: string;
  members: string[];
  setMembers: (patch: (m: string[]) => string[]) => void;
  projects: { id: string; slug: string }[];
}) {
  const addable = projects.filter((p) => !members.includes(p.id));
  return (
    <Field label={label}>
      <span className="flex flex-wrap items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5">
        {members.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setMembers((m) => m.filter((x) => x !== id))}
            className="rounded-pill px-2 py-px text-11-5 font-semibold"
            style={{ background: "var(--cobalt-50)", color: "var(--cobalt-700)" }}
          >
            {projects.find((p) => p.id === id)?.slug ?? id} ✕
          </button>
        ))}
        <select
          aria-label="Add a project"
          className="bg-transparent text-12 text-subtle"
          value=""
          onChange={(e) => e.target.value && setMembers((m) => [...m, e.target.value])}
        >
          <option value="">add a project…</option>
          {addable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.slug}
            </option>
          ))}
        </select>
      </span>
    </Field>
  );
}

function useSave(held: HeldEcosystem | null, doc: EcosystemDocument, steward: string, members: string[]) {
  const router = useRouter();
  const [invited, setInvited] = useState<Refusal[]>([]);
  const save = useChannelWrite(async () => {
    const document: EcosystemDocument = {
      ...doc,
      ecosystem: { ...doc.ecosystem, steward, slug: held ? doc.ecosystem.slug : slugOf(doc.ecosystem.name) },
    };
    const saved = held ? await ecosystemApi.write(held.id, held.revision, document) : await ecosystemApi.create(document);
    const refused: Refusal[] = [];
    for (const p of members) {
      try {
        await ecosystemApi.invite(saved.id, p);
      } catch (e) {
        refused.push(...refusalsOf(e));
      }
    }
    return { saved, refused };
  });
  const submit = () =>
    save.mutate(undefined, {
      onSuccess: ({ saved, refused }) => {
        setInvited(refused);
        if (refused.length === 0) router.push(ecosystemRoutes.ecosystem(saved.id));
      },
    });
  return { save, submit, invited };
}

function Form({ held }: { held: HeldEcosystem | null }) {
  const [doc, setDoc] = useState<EcosystemDocument>(held?.document ?? BLANK);
  const [members, setMembers] = useState<string[]>([]);
  const orgs = useOrgs().data ?? [];
  const stewards = orgs.filter((o) => o.role === "owner" || o.role === "admin");
  const projects = (useProjects().data ?? []).filter((p) => !p.archivedAt);
  const steward = doc.ecosystem.steward || stewards[0]?.id || "";
  const set: Patch = (patch) => setDoc((d) => patch(structuredClone(d)));
  const { save, submit, invited } = useSave(held, doc, steward, members);
  return (
    <div className="mx-auto grid w-full max-w-[520px] rounded-[14px] border border-line bg-surface shadow-lg">
      <div className="border-b border-line-subtle px-5 py-4">
        <h1 className="text-16 font-semibold">{held ? `${held.document.ecosystem.name} settings` : "New ecosystem"}</h1>
      </div>
      <div className="grid gap-3 px-5 py-4">
        <Field label="Name">
          <Input value={doc.ecosystem.name} onChange={(e) => set((d) => ({ ...d, ecosystem: { ...d.ecosystem, name: e.target.value } }))} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Document code" hint="Numbers every document, e.g. QE-RFI-1">
            <Input
              className="font-mono"
              value={doc.channel.code}
              onChange={(e) => set((d) => ({ ...d, channel: { ...d.channel, code: e.target.value.toUpperCase() } }))}
            />
          </Field>
          <Field label="Visibility">
            <NativeSelect
              value={doc.visibility.members}
              onChange={(e) => set((d) => ({ ...d, visibility: { members: e.target.value as "counterparties" | "all" } }))}
              options={[
                { value: "counterparties", label: "Members only" },
                { value: "all", label: "Every member sees every member" },
              ]}
            />
          </Field>
        </div>
        {stewards.length > 1 && !held ? (
          <Field label="Steward">
            <NativeSelect
              value={steward}
              onChange={(e) => set((d) => ({ ...d, ecosystem: { ...d.ecosystem, steward: e.target.value } }))}
              options={stewards.map((o) => ({ value: o.id, label: o.name }))}
            />
          </Field>
        ) : null}
        <ReplyWindowsField doc={doc} set={set} />
        <GateField doc={doc} set={set} />
        <MembersField label={held ? "Invite members" : "First members"} members={members} setMembers={setMembers} projects={projects} />
        {save.isError ? <RefusalNotice refusals={refusalsOf(save.error)} /> : null}
        {invited.length > 0 ? <RefusalNotice title="Saved, but an invitation was refused" refusals={invited} /> : null}
        {stewards.length === 0 && !held ? (
          <p className="fg-caption">An ecosystem is stewarded by an organization; you are owner or admin of none, so you cannot create one.</p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-line-subtle px-5 py-3">
        <Link
          href={held ? ecosystemRoutes.ecosystem(held.id) : ecosystemRoutes.list()}
          className="inline-flex items-center rounded-md border border-line bg-surface px-3 py-1.5 text-13 font-semibold text-fg hover:bg-hover"
        >
          Cancel
        </Link>
        <Button variant="primary" loading={save.isPending} disabled={!held && !steward} onClick={submit}>
          {held ? "Save" : "Create and add"}
        </Button>
      </div>
    </div>
  );
}

export function NewEcosystemScreen() {
  return <Form held={null} />;
}

export function EcosystemSettingsScreen({ ecosystemId }: { ecosystemId: string }) {
  const reading = readingOf(useEcosystemDocument(ecosystemId));
  if (reading.kind === "loading") return <Loading what="the ecosystem's settings" />;
  if (reading.kind === "unread") return <UnreadNotice what="The ecosystem's settings" refusals={reading.refusals} />;
  return <Form held={reading.value} />;
}
