
import { Link } from "@/lib/navigation/router";
import { useMemo, useState } from "react";
import { Badge, Button, Icon, Input, MonoTag, PageTitle } from "@/design";
import { useProjects } from "@/features/projects";
import { readingOf, refusalsOf } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { ecosystemApi } from "../api";
import type { Bus } from "../bus";
import { attentionOf, connectionsOf, summaryOf } from "../connections";
import { useBus, useChannelWrite, useMyEcosystems } from "../hooks";
import { ecosystemRoutes } from "../routes";
import { EcosystemMap } from "./ecosystem-map";
import { ConnectionsTable, NeedsAttention } from "./ecosystem-overview";
import { MemberProjects } from "./project-technical";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";
import type { WorkspaceEcosystem } from "../types";

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
  const mine = useMyEcosystems().data;
  const eco = mine?.ecosystems.find((e) => e.id === ecosystemId);
  const reading = readingOf(useBus(ecosystemId, true));
  const bus = reading.kind === "read" ? reading.value : null;
  const connections = useMemo(() => (bus ? connectionsOf(bus) : []), [bus]);
  const attention = useMemo(() => (bus ? attentionOf(bus, connections) : []), [bus, connections]);
  const readers = new Set(eco?.members ?? []);
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
        bus.projects.length === 0 ? (
          <p className={cn("fg-caption py-4", GUTTER)}>{t("ecosystem.screen.noMembers")}</p>
        ) : (
          <div className={cn("grid min-w-0 max-w-6xl grid-cols-1 gap-7 pb-10 pt-3", GUTTER)}>
            <p className="text-15 text-fg" data-testid="ecosystem-summary">
              {summaryOf(bus, connections, attention, t)}
            </p>
            <EcosystemMap bus={bus} connections={connections} />
            <NeedsAttention bus={bus} attention={attention} mine={slugs} />
            <ConnectionsTable bus={bus} connections={connections} />
            <MemberProjects bus={bus} mine={slugs} />
          </div>
        )
      ) : null}
    </div>
  );
}
