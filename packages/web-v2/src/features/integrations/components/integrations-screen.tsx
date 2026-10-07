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
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Button,
  PageSection,
  PageSectionBody,
  EmptyState,
  ErrorState,
  HelpButton,
  Input,
  NativeSelect,
  PageContainer,
  PageTitle,
  Popover,
  Skeleton,
} from "@/design";
import type { ConnectionDirectoryItem } from "@forge/contracts/integrations";
import { formatApiError } from "@/lib/api/error";
import { usePersistedState } from "@/lib/utils/use-persisted-state";
import { useActiveOrg } from "@/features/orgs/active-org";
import { useOrgs } from "@/features/orgs/hooks";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { useConnections } from "../hooks";
import { matchesQuery } from "../connection-identity";
import { groupConnectionsByApp } from "../connection-groups";
import { ConnectionEditDrawer } from "./connection-edit-drawer";
import { ConnectionGroupSection } from "./connection-group";
import { providerLabel } from "../providers/registry";
import { TopBarActions } from "@/design/primitives/top-bar-slot";

/** Per-operator, shared across tabs: which apps this person has shut. Every app stands open until then. */
const CLOSED_APPS_KEY = "web-v2:integrations-closed-apps";

/** One identity for "nothing is shut under this filter", so reads do not re-allocate. */
const EMPTY_APPS: string[] = [];

const HELP_ACTIONS = [
  "Click an app to open it, then a row — rename, replace the key, edit config, Test, drill into bound projects, or remove the connection",
  "Disable / Enable — switch a credential off (every binding stops resolving) and back on",
  "Binding-scoped settings (environment, webhooks, delivery log) stay in the project's settings → Integrations tab",
  "Add connection — a connection is made by connecting a provider from the project it serves; pick the project and its Integrations tab opens",
];

/** Where a connection is made: the project it serves. The act names the project and goes there. */
function AddConnection({ projects }: { projects: Array<{ id: string; slug: string; name: string }> }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <span ref={anchor} className="inline-flex">
        <Button variant="primary" size="sm" icon="plus" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Add connection
        </Button>
      </span>
      <Popover
        open={open}
        anchor={anchor}
        onDismiss={() => setOpen(false)}
        placement="bottom-end"
        takesFocus
        maxHeight={360}
        className="w-[300px] bg-surface p-3 shadow-md"
      >
        <p className="fg-body-sm mb-2 text-muted">
          A connection is made from the project it serves. Pick the project; its Integrations tab opens on the
          provider list.
        </p>
        {projects.length === 0 ? (
          <p className="fg-body-sm text-subtle">No project in this space yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-subtle">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.slug}/settings?tab=integrations`}
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

export function IntegrationsScreen() {
  const connections = useConnections();
  const { activeOrg } = useActiveOrg();
  const orgsQ = useOrgs();
  const projectsQ = useProjectsIncludingArchived();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");

  const orgNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of orgsQ.data ?? []) m.set(o.id, o.name);
    return m;
  }, [orgsQ.data]);

  const projectName = useCallback(
    (id: string) => (projectsQ.data ?? []).find((p) => p.id === id)?.name ?? id,
    [projectsQ.data],
  );

  const all = useMemo(() => connections.data?.items ?? [], [connections.data]);

  // ISS-477 — scope the directory to the active org: a personal org shows the
  // user's own (`ownerType:'user'`) credentials; a team org shows credentials
  // it owns. Connections from other orgs (or another principal) never appear.
  const inScope = useMemo(() => {
    if (!activeOrg) return all;
    return all.filter((c) =>
      activeOrg.isPersonal
        ? c.ownerType === "user"
        : c.ownerType === "org" && c.ownerId === activeOrg.id,
    );
  }, [all, activeOrg]);

  const providersPresent = useMemo(
    () => [...new Set(inScope.map((c) => c.provider))].sort(),
    [inScope],
  );

  const items = useMemo(
    () =>
      inScope.filter(
        (c) => (provider === "" || c.provider === provider) && matchesQuery(c, query, projectName),
      ),
    [inScope, provider, query, projectName],
  );

  const ownerLabel = useCallback(
    (c: ConnectionDirectoryItem) =>
      c.ownerType === "org" ? orgNameById.get(c.ownerId) ?? "Organization" : "Personal",
    [orgNameById],
  );

  const groups = useMemo(() => groupConnectionsByApp(items), [items]);

  const spaceProjects = useMemo(
    () =>
      (projectsQ.data ?? [])
        .filter((p) => p.archivedAt === null && (!activeOrg || p.orgId === activeOrg.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [projectsQ.data, activeOrg],
  );

  // Which apps stand open. The PERSISTED half is the operator's own choice and
  // survives leaving the page; the transient half is theirs for the life of ONE
  // filter value, because a filter that leaves its match behind a shut header
  // reads as a filter that does not work, and a header it renders open has to
  // stay clickable rather than become a control that does nothing.
  const [closedApps, setClosedApps] = usePersistedState<string[]>(CLOSED_APPS_KEY, []);
  const filtering = query.trim() !== "" || provider !== "";
  // Any CHANGE to either filter drops the transient collapses, because a new
  // question may not have its answer hidden behind a header shut in answer to
  // the last one — and returning to a filter typed before is a new question
  // too, so what is compared is the PREVIOUS filter rather than the one a
  // collapse was made under. Compared while rendering rather than in an effect:
  // an effect would paint the stale set once before clearing it, and `closedNow`
  // is what makes this render right whether or not the setState below has
  // landed yet.
  const filterKey = `${query}\u0000${provider}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  const [filterClosed, setFilterClosed] = useState<string[]>([]);
  const closedNow = lastFilterKey === filterKey ? filterClosed : EMPTY_APPS;
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setFilterClosed(EMPTY_APPS);
  }

  const isOpen = (key: string) =>
    filtering ? !closedNow.includes(key) : !closedApps.includes(key);

  const toggleApp = (key: string) => {
    const flip = (prev: string[]) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key];
    if (filtering) setFilterClosed(flip(closedNow));
    else setClosedApps(flip);
  };

  // Track the SELECTED ID and re-derive the row from the live query data, so
  // the open drawer reflects every mutation (rename/health/active) without
  // holding a stale snapshot. Stable onClose — SlideOver's focus effect keys
  // on it, and a fresh identity per render would yank focus on every refetch.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((c) => c.id === selectedId) ?? null;
  const closeDrawer = useCallback(() => setSelectedId(null), []);

  const scopeName = activeOrg
    ? activeOrg.isPersonal
      ? "your personal space"
      : activeOrg.name
    : "this workspace";

  function renderEmpty() {
    if (inScope.length > 0) {
      return (
        <EmptyState
          title="No connection matches"
          message={`None of the ${inScope.length} connections in ${scopeName} match this filter.`}
          mascot={false}
          action={{
            label: "Clear filters",
            onClick: () => {
              setQuery("");
              setProvider("");
            },
          }}
        />
      );
    }
    if (all.length > 0) {
      return (
        <EmptyState
          title={`No connections in ${scopeName}`}
          message={`You can see ${all.length} connection${all.length > 1 ? "s" : ""} in your other spaces — switch space in the sidebar to reach ${all.length > 1 ? "them" : "it"}.`}
          mascot={false}
        />
      );
    }
    return (
      <EmptyState
        title="No connections yet"
        message="A connection is made by connecting a provider from the project it serves — Add connection picks the project."
        mascot={false}
      />
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageTitle
        hint={`The connections in ${scopeName}: credentials shared across projects. A project's own integrations are in its settings → Integrations.`}
      >
        Integrations
      </PageTitle>
      <TopBarActions>
        <AddConnection projects={spaceProjects} />
        <HelpButton
          summary="A connection is a credential owned by you or one of your organizations (Coolify token, GitHub App). Projects use a connection through bindings — share one connection with several projects without re-entering the secret. Health here is the connection's real last-known state; disabled connections stay listed so you can re-enable them."
          actions={HELP_ACTIONS}
        />
      </TopBarActions>

      {inScope.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="min-w-[240px] flex-1 sm:max-w-[420px]">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, endpoint or project…"
              aria-label="Search connections"
            />
          </div>
          <div className="w-[200px] shrink-0">
            <NativeSelect
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              aria-label="Filter by provider"
              options={[
                { value: "", label: "All providers" },
                ...providersPresent.map((p) => ({
                  value: p,
                  label: providerLabel(p),
                })),
              ]}
            />
          </div>
          <span className="fg-body-sm text-subtle">
            {items.length === inScope.length
              ? `${inScope.length} connections`
              : `${items.length} of ${inScope.length} connections`}
          </span>
        </div>
      )}

      {connections.isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[52px] w-full" />
          ))}
        </div>
      ) : connections.isError ? (
        <ErrorState
          message={formatApiError(connections.error)}
          onRetry={() => connections.refetch()}
        />
      ) : items.length === 0 ? (
        <PageSection>
          <PageSectionBody>{renderEmpty()}</PageSectionBody>
        </PageSection>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <ConnectionGroupSection
              key={g.provider}
              group={g}
              open={isOpen(g.provider)}
              onToggle={() => toggleApp(g.provider)}
              ownerLabel={ownerLabel}
              projectName={projectName}
              onOpenConnection={setSelectedId}
            />
          ))}
        </div>
      )}

      {
        selected && <ConnectionEditDrawer connection={selected} onClose={closeDrawer} />
      }
    </PageContainer>
  );
}
