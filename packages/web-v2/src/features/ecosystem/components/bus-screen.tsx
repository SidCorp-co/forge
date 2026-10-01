"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, Input, Tooltip } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import type { ProjectListItem } from "@/features/projects/types";
import { canWriteProject } from "@/features/projects/write-access";
import { readingOf, refusalsOf } from "@/lib/api/refusals";
import { cn } from "@/lib/utils/cn";
import { ecosystemApi } from "../api";
import { type Bus, busRows, type Tone } from "../bus";
import { useBus, useChannelWrite, useProjectEcosystems } from "../hooks";
import { ecosystemRoutes } from "../routes";
import { BusDiagram, IMPACT_NOTE, type Lens, type Selection } from "./bus-diagram";
import { BusDetail } from "./bus-detail";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";

const LEGEND: { tone: Tone; label: string; tip: string }[] = [
  { tone: "ok", label: "current", tip: "The link pins the contract's current version" },
  { tone: "warn", label: "behind", tip: "A newer version of the contract exists" },
  { tone: "bad", label: "breaking", tip: "The version in use no longer works against the contract" },
  { tone: "pend", label: "building", tip: "The builder found the call and is still writing its guide, or nothing has verified it yet" },
  { tone: "own", label: "provides", tip: "The provider's own chip, showing the contract's current version" },
];

function AddProject({ ecosystemId, bus }: { ecosystemId: string; bus: Bus }) {
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState("");
  const mine = useProjects();
  const invite = useChannelWrite((project: string) => ecosystemApi.invite(ecosystemId, project));
  const onBus = new Set(bus.projects.map((p) => p.id));
  const candidates = (mine.data ?? []).filter((p) => !onBus.has(p.id) && !p.archivedAt);
  return (
    <div className="relative">
      <Tooltip label="Invites a project into this ecosystem; an admin of that project accepts it, and its master then maps its links" multiline>
        <Button size="sm" icon="plus" type="button" onClick={() => setOpen((o) => !o)}>
          Add project
        </Button>
      </Tooltip>
      {open ? (
        <div className="absolute right-0 top-full z-10 mt-1 grid w-[300px] gap-2 rounded-lg border border-line bg-surface p-3 shadow-md">
          {candidates.length === 0 ? (
            <p className="fg-caption">Every project you can open is already on the bus.</p>
          ) : (
            <ul className="grid max-h-[220px] gap-1 overflow-auto">
              {candidates.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={invite.isPending}
                    onClick={() => invite.mutate(p.id, { onSuccess: () => setOpen(false) })}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-13 hover:bg-hover"
                  >
                    <span className="truncate font-semibold">{p.slug}</span>
                    <span className="fg-caption truncate">{p.orgName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Input aria-label="Another organization's project id" placeholder="another org's project id" value={other} onChange={(e) => setOther(e.target.value)} />
            <Button
              size="sm"
              type="button"
              disabled={other.trim() === ""}
              loading={invite.isPending}
              onClick={() => invite.mutate(other.trim(), { onSuccess: () => setOpen(false) })}
            >
              Invite
            </Button>
          </div>
          {invite.isError ? <RefusalNotice refusals={refusalsOf(invite.error)} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function LensBar({ lens, onLens }: { lens: Lens; onLens: (l: Lens) => void }) {
  const opt = (value: Lens, label: string, tip: string) => (
    <Tooltip label={tip} multiline>
      <button
        type="button"
        aria-pressed={lens === value}
        onClick={() => onLens(value)}
        className={cn(
          "flex items-center gap-1.5 rounded-pill border px-3 py-1 text-12-5 font-semibold",
          lens === value ? "border-[var(--fg-default)] bg-[var(--fg-default)] text-[var(--bg-surface)]" : "border-line bg-surface text-muted",
        )}
      >
        {value === "live" ? <i className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: "var(--green-500)" }} /> : null}
        {label}
      </button>
    </Tooltip>
  );
  return (
    <div className="flex gap-1.5">
      {opt("live", "Live", "Each link as its master last recorded it, refreshed every 15 seconds; a chip whose project's builder is running rings")}
      {opt("impact", "Impact", `Pick a contract to see which consumers it reaches. ${IMPACT_NOTE}`)}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3.5 text-12 text-muted">
      {LEGEND.map((k) => (
        <Tooltip key={k.tone} label={k.tip} multiline>
          <span>
            <i className="eco-key" data-tone={k.tone} />
            {k.label}
          </span>
        </Tooltip>
      ))}
      <Tooltip label="The link's guide records surface it uses outside the published contract">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--amberw-500)" }} />
          outside the contract
        </span>
      </Tooltip>
    </div>
  );
}

function defaultSelection(bus: Bus, readerId: string): Selection | null {
  const p = bus.projects.find((x) => x.id === readerId) ?? bus.projects[0];
  return p ? { kind: "project", id: p.id } : null;
}

function BusView({ ecosystemId, project }: { ecosystemId: string; project: ProjectListItem }) {
  const [lens, setLens] = useState<Lens>("live");
  const [picked, setPicked] = useState<Selection | null>(null);
  const reading = readingOf(useBus(ecosystemId, lens === "live"));
  const bus = reading.kind === "read" ? reading.value : null;
  const rows = useMemo(() => (bus ? busRows(bus) : []), [bus]);
  if (reading.kind === "loading") return <Loading what="the ecosystem's bus" />;
  if (reading.kind === "unread") return <UnreadNotice what="The ecosystem's bus" refusals={reading.refusals} />;
  const b = reading.value;
  const sel = picked ?? defaultSelection(b, project.id);
  const onSelect = (s: Selection) => {
    if (s.kind === "contract") setLens("impact");
    setPicked(s);
  };
  const onLens = (l: Lens) => {
    setLens(l);
    if (l === "impact" && sel?.kind !== "contract") {
      const first = rows.find((r) => r.links.length > 0) ?? rows[0];
      if (first) setPicked({ kind: "contract", key: first.key });
    }
  };
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="fg-h3 truncate">{b.ecosystem.name}</h2>
          <Tooltip label={`Ecosystem ${b.ecosystem.slug} · ${b.projects.length} members on the bus you can see`}>
            <span className="rounded-[5px] bg-[var(--cobalt-50)] px-1.5 font-mono text-12" style={{ color: "var(--cobalt-700)" }}>
              {b.ecosystem.slug}
            </span>
          </Tooltip>
        </div>
        {canWriteProject(project.role) ? <AddProject ecosystemId={ecosystemId} bus={b} /> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <Legend />
        <LensBar lens={lens} onLens={onLens} />
      </div>
      {sel ? (
        <>
          <BusDiagram bus={b} rows={rows} lens={lens} sel={sel} readerId={project.id} onSelect={onSelect} />
          <BusDetail bus={b} rows={rows} sel={sel} onSelect={onSelect} />
        </>
      ) : (
        <p className="fg-caption">No member of {b.ecosystem.name} is visible to you yet.</p>
      )}
    </div>
  );
}

export function BusScreen({ project, rawEcosystem }: { project: ProjectListItem; rawEcosystem: string | null }) {
  const ecos = readingOf(useProjectEcosystems(project.id));
  if (ecos.kind === "loading") return <Loading what="this project's ecosystems" />;
  if (ecos.kind === "unread") return <UnreadNotice what="This project's ecosystems" refusals={ecos.refusals} />;
  const active = ecos.value.memberships.filter((m) => m.document.state === "active" && m.ecosystem);
  if (active.length === 0) {
    return (
      <p className="fg-caption">
        {project.slug} is an active member of no ecosystem, so there is no bus to draw. A steward invites it, and an admin of {project.slug} accepts.
      </p>
    );
  }
  const chosen = active.find((m) => m.ecosystem?.id === rawEcosystem) ?? (rawEcosystem ? null : active[0]);
  return (
    <div className="grid min-w-0 gap-3">
      {active.length > 1 ? (
        <nav aria-label="Ecosystems" className="flex flex-wrap gap-1.5">
          {active.map((m) => (
            <Link
              key={m.id}
              href={ecosystemRoutes.bus(project.slug, { ecosystem: m.ecosystem?.id })}
              aria-current={m.ecosystem?.id === chosen?.ecosystem?.id ? "page" : undefined}
              className={cn(
                "rounded-pill border px-3 py-0.5 text-12-5 font-semibold",
                m.ecosystem?.id === chosen?.ecosystem?.id ? "border-[var(--fg-default)] bg-[var(--fg-default)] text-[var(--bg-surface)]" : "border-line text-muted",
              )}
            >
              {m.ecosystem?.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {chosen?.ecosystem ? (
        <BusView key={chosen.ecosystem.id} ecosystemId={chosen.ecosystem.id} project={project} />
      ) : (
        <RefusalNotice
          title="Not one of this project's ecosystems"
          refusals={[
            {
              code: "ECOSYSTEM_NOT_MEMBER",
              path: "?ecosystem",
              detail: `${project.slug} is not an active member of ecosystem ${rawEcosystem}.`,
            },
          ]}
        />
      )}
    </div>
  );
}
