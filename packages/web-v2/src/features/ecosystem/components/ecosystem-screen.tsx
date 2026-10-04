"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, Icon, Input, PageTitle, Tooltip } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { readingOf, refusalsOf } from "@/lib/api/refusals";
import { cn } from "@/lib/utils/cn";
import { ecosystemApi } from "../api";
import { type Bus, busRows, STATE_MEANING, type Tone } from "../bus";
import { useBus, useChannelWrite, useMyEcosystems } from "../hooks";
import { ecosystemRoutes } from "../routes";
import { BusDiagram, type Lens, type Selection } from "./bus-diagram";
import { BusDetail } from "./bus-detail";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";
import type { WorkspaceEcosystem } from "../types";

const LEGEND: { tone: Tone; label: string; tip: string }[] = [
  { tone: "ok", label: "current", tip: "The link pins the contract's current version" },
  { tone: "warn", label: "behind", tip: STATE_MEANING.behind },
  { tone: "bad", label: "breaking", tip: STATE_MEANING.breaking },
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
      {opt("impact", "Impact", "Pick a contract to see which consumers its latest version breaks, checked against the fields and surface each one uses")}
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

function defaultSelection(bus: Bus, readers: ReadonlySet<string>): Selection | null {
  const p = bus.projects.find((x) => readers.has(x.id)) ?? bus.projects[0];
  return p ? { kind: "project", id: p.id } : null;
}

const GUTTER = "px-4 sm:px-7";

function EcosystemHeader({ eco, bus }: { eco: WorkspaceEcosystem | undefined; bus: Bus | null }) {
  const name = eco?.name ?? bus?.ecosystem.name ?? "Ecosystem";
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-3 pt-5", GUTTER)}>
      <PageTitle className="truncate text-[22px] font-bold">{name}</PageTitle>
      {eco ? (
        <Tooltip label={`Document code: every document in ${name} is numbered ${eco.code}-…`}>
          <span className="rounded-[5px] px-[7px] py-px font-mono text-12" style={{ background: "var(--cobalt-50)", color: "var(--cobalt-700)" }}>
            {eco.code}
          </span>
        </Tooltip>
      ) : null}
      {eco?.steward.name ? (
        <Tooltip label={`${eco.steward.name} stewards ${name}: it invites members and sets the reply windows and the approve gates`} multiline>
          <span className="rounded-pill px-2 py-px text-11-5 font-semibold" style={{ background: "var(--cobalt-50)", color: "var(--cobalt-700)" }}>
            Steward · {eco.steward.name}
          </span>
        </Tooltip>
      ) : null}
      {eco?.steward.mine && bus ? (
        <span className="ml-auto flex gap-2">
          <AddProject ecosystemId={eco.id} bus={bus} />
          <Link
            href={ecosystemRoutes.settings(eco.id)}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1 text-13 font-semibold text-fg hover:bg-hover"
          >
            <Icon name="settings" size={14} />
            Settings
          </Link>
        </span>
      ) : null}
    </div>
  );
}

export function EcosystemScreen({ ecosystemId }: { ecosystemId: string }) {
  const [lens, setLens] = useState<Lens>("live");
  const [picked, setPicked] = useState<Selection | null>(null);
  const mine = useMyEcosystems().data;
  const eco = mine?.ecosystems.find((e) => e.id === ecosystemId);
  const readers = useMemo(() => new Set(eco?.members ?? []), [eco]);
  const reading = readingOf(useBus(ecosystemId, lens === "live"));
  const bus = reading.kind === "read" ? reading.value : null;
  const rows = useMemo(() => (bus ? busRows(bus) : []), [bus]);
  const sel = picked ?? (bus ? defaultSelection(bus, readers) : null);
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
  const slugs = new Map((mine?.projects ?? []).filter((p) => readers.has(p.id)).map((p) => [p.id, p.slug]));
  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <EcosystemHeader eco={eco} bus={bus} />
      {reading.kind === "loading" ? (
        <div className={cn("py-4", GUTTER)}>
          <Loading what="the ecosystem's bus" />
        </div>
      ) : null}
      {reading.kind === "unread" ? (
        <div className={cn("py-4", GUTTER)}>
          <UnreadNotice what="The ecosystem's bus" refusals={reading.refusals} />
        </div>
      ) : null}
      {bus ? (
        <>
          <div className={cn("flex min-w-0 flex-wrap items-center justify-between gap-4 pb-1 pt-2", GUTTER)}>
            <Legend />
            <LensBar lens={lens} onLens={onLens} />
          </div>
          {sel ? (
            <>
              <BusDiagram bus={bus} rows={rows} lens={lens} sel={sel} readers={readers} onSelect={onSelect} />
              <BusDetail bus={bus} rows={rows} sel={sel} mine={slugs} onSelect={onSelect} />
            </>
          ) : (
            <p className={cn("fg-caption py-4", GUTTER)}>No member of {bus.ecosystem.name} is visible to you yet.</p>
          )}
        </>
      ) : null}
    </div>
  );
}
