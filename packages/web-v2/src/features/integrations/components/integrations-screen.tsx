"use client";

// Workspace `/integrations` — the OWNER CONNECTION DIRECTORY (ISS-429).
//
// A connection is the credential (owned by a user or an org); bindings link it
// into projects. The directory is one collapsible section per APP rather than
// one grid of equal cards (ISS-1035): an org holding several credentials of one
// app — a Coolify token per environment — read as an undifferentiated wall, and
// the operator comes looking for an app before a credential. What a row holds,
// and what it deliberately does not: `connection-row.tsx`.

import Link from "next/link";
import { useRef, useState } from "react";
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageContainer,
  PageTitle,
  Popover,
  ToolbarSelect,
  TopBarActions,
} from "@/design";
import type { ConnectionDirectoryItem } from "@forge/contracts/integrations";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { useActiveOrg, useOrgs } from "@/features/orgs";
import { useProjectsIncludingArchived } from "@/features/projects";
import { useConnections } from "../hooks";
import { matchesQuery } from "../connection-identity";
import { groupConnectionsByApp } from "../connection-groups";
import { ConnectionEditDrawer } from "./connection-edit-drawer";
import { ConnectionGroupList } from "./connection-group";
import { providerLabel } from "../providers/registry";

/** Per-operator, shared across tabs: which apps this person has shut. Every app stands open until then. */
const CLOSED_APPS_KEY = "web-v2:integrations-closed-apps";

/** One identity for "nothing is shut under this filter", so reads do not re-allocate. */
const EMPTY_APPS: string[] = [];

/** Where a connection is made: the project it serves. The act names the project and goes there. */
function AddConnection({ projects }: { projects: Array<{ id: string; slug: string; name: string }> }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const t = useCopy();
  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        <Button variant="primary" size="sm" icon="plus" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {t("integrations.add")}
        </Button>
      </span>
      <Popover
        open={open}
        anchor={anchorRef}
        onDismiss={() => setOpen(false)}
        placement="bottom-end"
        takesFocus
        maxHeight={360}
        className="w-75 bg-surface p-3"
      >
        {projects.length === 0 ? (
          <p className="fg-body-sm text-subtle">{t("integrations.addNoProject")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-subtle">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.slug}/settings?tab=connections#integrations`}
                  className="block py-2 text-13 font-semibold text-fg hover:text-accent"
                  onClick={() => setOpen(false)}
                >
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </>
  );
}

/**
 * Which apps stand open. The PERSISTED half is the operator's own choice and survives leaving the
 * page; the transient half is theirs for the life of ONE filter value, because a filter that leaves
 * its match behind a shut header reads as a filter that does not work. Any CHANGE to the filter drops
 * the transient collapses, compared while rendering rather than in an effect: an effect would paint
 * the stale set once before clearing it, and `closedNow` makes this render right either way.
 */
function useOpenApps(filterKey: string, filtering: boolean) {
  const [closedApps, setClosedApps] = usePersistedState<string[]>(CLOSED_APPS_KEY, []);
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  const [filterClosed, setFilterClosed] = useState<string[]>([]);
  const closedNow = lastFilterKey === filterKey ? filterClosed : EMPTY_APPS;
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setFilterClosed(EMPTY_APPS);
  }
  const flip = (key: string) => (prev: string[]) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]);
  return {
    isOpen: (key: string) => (filtering ? !closedNow.includes(key) : !closedApps.includes(key)),
    toggle: (key: string) => {
      if (filtering) setFilterClosed(flip(key)(closedNow));
      else setClosedApps(flip(key));
    },
  };
}

/** Why the directory is empty: the filter, the active org, or no connection at all. */
function DirectoryEmpty({ inScope, all, onClear }: { inScope: number; all: number; onClear: () => void }) {
  const t = useCopy();
  if (inScope > 0) {
    return <EmptyState message={t("integrations.empty.noMatch")} mascot={false} action={{ label: t("integrations.empty.clearFilters"), onClick: onClear }} />;
  }
  if (all > 0) {
    return (
      <EmptyState
        title={t("integrations.empty.noneIn")}
        message={all > 1 ? t("integrations.empty.elsewhereMany", { n: all }) : t("integrations.empty.elsewhereOne")}
        mascot={false}
      />
    );
  }
  return <EmptyState message={t("integrations.empty.none")} mascot={false} />;
}

export function IntegrationsScreen() {
  const connections = useConnections();
  const { activeOrg } = useActiveOrg();
  const orgsQ = useOrgs();
  const projectsQ = useProjectsIncludingArchived();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const t = useCopy();
  const language = useInterfaceLanguage();

  const orgNameById = new Map((orgsQ.data ?? []).map((o) => [o.id, o.name] as const));
  const projectName = (id: string) => (projectsQ.data ?? []).find((p) => p.id === id)?.name ?? id;
  const all = connections.data?.items ?? [];
  // ISS-477 — scope the directory to the active org: a personal org shows the user's own
  // (`ownerType:'user'`) credentials; a team org shows credentials it owns. Connections from other
  // orgs (or another principal) never appear.
  const inScope = activeOrg
    ? all.filter((c) => (activeOrg.isPersonal ? c.ownerType === "user" : c.ownerType === "org" && c.ownerId === activeOrg.id))
    : all;
  const providersPresent = [...new Set(inScope.map((c) => c.provider))].sort();
  const items = inScope.filter((c) => (provider === "" || c.provider === provider) && matchesQuery(c, query, projectName, language));
  const ownerLabel = (c: ConnectionDirectoryItem) =>
    c.ownerType === "org" ? (orgNameById.get(c.ownerId) ?? t("integrations.owner.org")) : t("overview.personal");
  const groups = groupConnectionsByApp(items, language);
  const spaceProjects = (projectsQ.data ?? [])
    .filter((p) => p.archivedAt === null && (!activeOrg || p.orgId === activeOrg.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const apps = useOpenApps(`${query}\u0000${provider}`, query.trim() !== "" || provider !== "");

  // The SELECTED ID, with the row re-derived from the live query data, so the open drawer reflects
  // every mutation (rename/health/active) without holding a stale snapshot.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((c) => c.id === selectedId) ?? null;

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageTitle>{t("integrations.title")}</PageTitle>
      <TopBarActions>
        <AddConnection projects={spaceProjects} />
      </TopBarActions>

      {inScope.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-60 flex-1 sm:max-w-105">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("integrations.search")} aria-label={t("integrations.searchAria")} />
          </div>
          <ToolbarSelect
            label={t("integrations.filterProvider")}
            value={provider}
            onChange={setProvider}
            options={[{ value: "", label: t("integrations.allProviders") }, ...providersPresent.map((p) => ({ value: p, label: providerLabel(p, language) }))]}
          />
          <span className="fg-body-sm text-subtle">
            {items.length === inScope.length ? t("integrations.count", { n: inScope.length }) : t("integrations.countOf", { n: items.length, total: inScope.length })}
          </span>
        </div>
      ) : null}

      {connections.isLoading ? (
        <LoadingState rows={4} label={t("integrations.title")} />
      ) : connections.isError ? (
        <ErrorState message={formatApiError(connections.error)} onRetry={() => void connections.refetch()} />
      ) : items.length === 0 ? (
        <DirectoryEmpty
          inScope={inScope.length}
          all={all.length}
          onClear={() => {
            setQuery("");
            setProvider("");
          }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <ConnectionGroupList
              key={g.provider}
              group={g}
              open={apps.isOpen(g.provider)}
              onToggle={() => apps.toggle(g.provider)}
              ownerLabel={ownerLabel}
              projectName={projectName}
              onOpenConnection={setSelectedId}
            />
          ))}
        </div>
      )}

      {selected ? <ConnectionEditDrawer connection={selected} onClose={() => setSelectedId(null)} /> : null}
    </PageContainer>
  );
}
