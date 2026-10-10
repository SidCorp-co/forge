
import { Link } from "@/lib/navigation/router";
import { useMemo, useState } from "react";
import { Badge, Button, Icon, Input, MonoTag, PageTitle, SegmentedControl, Tooltip } from "@/design";
import { useProjects } from "@/features/projects";
import { readingOf, refusalsOf } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { ecosystemApi } from "../api";
import { type Bus, busRows, stateMeaning, type Tone } from "../bus";
import { useBus, useChannelWrite, useMyEcosystems } from "../hooks";
import { ecosystemRoutes } from "../routes";
import { BusDiagram, type Lens, type Selection } from "./bus-diagram";
import { BusDetail } from "./bus-detail";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";
import type { WorkspaceEcosystem } from "../types";

const LEGEND: { tone: Tone; label: ProductCopyKey; tip: (t: Copy) => string }[] = [
  { tone: "ok", label: "ecosystem.legend.current", tip: (t) => t("ecosystem.legend.currentTip") },
  { tone: "warn", label: "ecosystem.legend.behind", tip: (t) => stateMeaning("behind", t) },
  { tone: "bad", label: "ecosystem.legend.breaking", tip: (t) => stateMeaning("breaking", t) },
  { tone: "pend", label: "ecosystem.legend.building", tip: (t) => t("ecosystem.legend.buildingTip") },
  { tone: "own", label: "ecosystem.legend.provides", tip: (t) => t("ecosystem.legend.providesTip") },
];

function AddProject({ ecosystemId, bus }: { ecosystemId: string; bus: Bus }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState("");
  const mine = useProjects();
  const invite = useChannelWrite((project: string) => ecosystemApi.invite(ecosystemId, project));
  const onBus = new Set(bus.projects.map((p) => p.id));
  const candidates = (mine.data ?? []).filter((p) => !onBus.has(p.id) && !p.archivedAt);
  return (
    <div className="relative">
      <Button size="sm" icon="plus" type="button" onClick={() => setOpen((o) => !o)}>
        {t("ecosystem.screen.addProject")}
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-10 mt-1 grid w-75 gap-2 border border-line bg-surface p-3">
          {candidates.length === 0 ? (
            <p className="fg-caption">{t("ecosystem.screen.allOnBus")}</p>
          ) : (
            <ul className="grid max-h-55 gap-1 overflow-auto">
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
            <Input
              aria-label={t("ecosystem.screen.otherProject")}
              placeholder={t("ecosystem.screen.otherProjectPlaceholder")}
              value={other}
              onChange={(e) => setOther(e.target.value)}
            />
            <Button
              size="sm"
              type="button"
              disabled={other.trim() === ""}
              loading={invite.isPending}
              onClick={() => invite.mutate(other.trim(), { onSuccess: () => setOpen(false) })}
            >
              {t("ecosystem.screen.invite")}
            </Button>
          </div>
          {invite.isError ? <RefusalNotice refusals={refusalsOf(invite.error)} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function LensBar({ lens, onLens }: { lens: Lens; onLens: (l: Lens) => void }) {
  const t = useCopy();
  return (
    <SegmentedControl<Lens>
      value={lens}
      onChange={onLens}
      options={[
        {
          value: "live",
          label: t("ecosystem.screen.live"),
          icon: "activity",
        },
        {
          value: "impact",
          label: t("ecosystem.bus.impact"),
        },
      ]}
    />
  );
}

function Legend() {
  const t = useCopy();
  return (
    <div className="flex flex-wrap items-center gap-3.5 text-12 text-muted">
      {LEGEND.map((k) => (
        <Tooltip key={k.tone} label={k.tip(t)} multiline>
          <span>
            <i className="eco-key" data-tone={k.tone} />
            {t(k.label)}
          </span>
        </Tooltip>
      ))}
      <Tooltip label={t("ecosystem.legend.outsideTip")}>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--amberw-500)" }} />
          {t("ecosystem.legend.outside")}
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
  const t = useCopy();
  const name = eco?.name ?? bus?.ecosystem.name ?? t("ecosystem.screen.ecosystem");
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-3 pt-5", GUTTER)}>
      <PageTitle className="truncate text-20 font-bold">{name}</PageTitle>
      {eco ? (
        <MonoTag hue="cobalt">{eco.code}</MonoTag>
      ) : null}
      {eco?.steward.name ? (
        <Badge tone="cobalt">{t("ecosystem.screen.steward", { name: eco.steward.name })}</Badge>
      ) : null}
      {eco?.steward.mine && bus ? (
        <span className="ml-auto flex gap-2">
          <AddProject ecosystemId={eco.id} bus={bus} />
          <Link
            href={ecosystemRoutes.settings(eco.id)}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1 text-13 font-semibold text-fg hover:bg-hover"
          >
            <Icon name="settings" size={14} />
            {t("ecosystem.screen.settings")}
          </Link>
        </span>
      ) : null}
    </div>
  );
}

export function EcosystemScreen({ ecosystemId }: { ecosystemId: string }) {
  const t = useCopy();
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
          <Loading what={t("ecosystem.screen.busWhat")} />
        </div>
      ) : null}
      {reading.kind === "unread" ? (
        <div className={cn("py-4", GUTTER)}>
          <UnreadNotice what={t("ecosystem.screen.busWhat")} refusals={reading.refusals} />
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
            <p className={cn("fg-caption py-4", GUTTER)}>{t("ecosystem.screen.noMembers")}</p>
          )}
        </>
      ) : null}
    </div>
  );
}
