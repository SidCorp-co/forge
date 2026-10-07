"use client";

import { CONTRACT_ATTENTION_GROUPS, CONTRACT_ATTENTION_LABELS } from "@forge/contracts/contract-standing";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useMemo } from "react";
import {
  EmptyState,
  GroupedList,
  type ListGroup,
  type ListRowView,
  ListSearch,
  EnumBadge,
  PageTitle,
  StatusBadge,
  rememberListOrigin,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlParams,
  useViewMode,
  ViewModeSwitcher,
  visibleRows,
  WaitingOn,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { cn } from "@/lib/utils/cn";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { useContractStanding } from "../hooks";
import { CONTRACTS_LIST, contractHref } from "@/lib/routes/contracts";
import type { ContractStandingRow } from "../types";
import { versionLine, WindowText } from "./contract-bits";
import { ContractPeek } from "./contract-peek";

const GROUP_MODES = [
  { value: "attention" as const, label: "Attention", title: "Grouped by whose turn it is" },
  { value: "direction" as const, label: "Direction", title: "Grouped by what this project provides and what it consumes" },
];
type GroupMode = (typeof GROUP_MODES)[number]["value"];

const COLUMNS = { key: "Contract", title: "Title", state: "State", meta: "Window · last version" } as const;

function groupsOf(rows: ContractStandingRow[], mode: GroupMode, slug: string): ListGroup<ContractStandingRow>[] {
  if (mode === "direction") {
    return [
      { id: "provided", label: `Provided by ${slug}`, tone: null, rows: rows.filter((r) => r.direction === "provided") },
      { id: "consumed", label: "Consumed from other projects", tone: null, rows: rows.filter((r) => r.direction === "consumed") },
    ];
  }
  return CONTRACT_ATTENTION_GROUPS.map((g) => ({
    id: g,
    label: CONTRACT_ATTENTION_LABELS[g].label,
    tone: CONTRACT_ATTENTION_LABELS[g].tone,
    collapsed: CONTRACT_ATTENTION_LABELS[g].collapsed,
    rows: rows.filter((r) => r.attentionGroup === g),
  }));
}

function factsLine(r: ContractStandingRow): ReactNode[] {
  const parts: ReactNode[] = [<EnumBadge key="kind" family="interfaceType" value={r.kind} />];
  parts.push(r.direction === "consumed" ? `From ${r.provider.slug}` : "Provided");
  parts.push(versionLine(r));
  if (r.direction === "provided" && r.consumers.total > 0) parts.push(`Consumers ${r.consumers.total}${r.consumers.behind ? ` · behind ${r.consumers.behind}` : ""}`);
  return parts;
}

const rowOf =
  (slug: string) =>
  (r: ContractStandingRow): ListRowView => ({
    key: r.ref,
    keyLabel: (
      <span className="whitespace-normal break-words" title={r.ref}>
        {r.slug}
      </span>
    ),
    href: contractHref(slug, r.ref),
    title: r.title,
    facts: factsLine(r),
    state: <StatusBadge family="contractState" value={r.state} />,
    waitingOn: <WaitingOn w={r.waitingOn} />,
    owner: <WindowText row={r} />,
    age: r.touchedAt ? { text: formatAge(r.touchedAt), title: `Last version recorded ${formatStamp(r.touchedAt)}` } : null,
    dim: r.attentionGroup === "steady" && r.state === "deprecated",
  });

export function ContractsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useContractStanding(projectId);
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [mode, setMode] = useViewMode(GROUP_MODES);
  const text = params.get("q") ?? "";
  const fold = useGroupFold("web-v2:contracts-fold");

  const all = q.data?.contracts ?? [];
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? all.filter((r) => `${r.ref} ${r.title} ${r.summary ?? ""}`.toLowerCase().includes(t)) : all;
  }, [all, text]);
  const groups = useMemo(() => groupsOf(rows, mode, slug), [rows, mode, slug]);
  const visible = useMemo(() => visibleRows(groups, fold).map((r) => r.ref), [groups, fold]);
  const allKeys = useMemo(() => all.map((r) => r.ref), [all]);
  const peek = usePeek(visible, allKeys);
  const row = useMemo(() => rowOf(slug), [slug]);

  const openFull = useCallback(
    (key: string) => {
      rememberListOrigin(CONTRACTS_LIST);
      router.push(contractHref(slug, key));
    },
    [router, slug],
  );
  usePeekKeys(peek, openFull);

  const title = <PageTitle after={<ViewModeSwitcher modes={GROUP_MODES} value={mode} onChange={setMode} placement="header" />}>Contracts</PageTitle>;
  return (
    <QueryBoundary query={q} loadingLabel="loading contracts…" title={title} height="60vh" retry="always">
      {(data) => (
        <div className="grid min-h-full content-start bg-app" data-testid="contracts-screen">
          {title}
          <div className={cn("grid min-h-[60vh] items-start", peek.open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
                <ViewModeSwitcher modes={GROUP_MODES} value={mode} onChange={setMode} placement="toolbar" />
                <ListSearch noun="contracts" value={text} onChange={(v) => setParams({ q: v || null })} />
                <span className="ml-auto text-12 text-subtle" title="Read from the interface document, the consumer links, the recorded versions and the issues that wait on a version">
                  {data.declared ? "Interface document declared" : "No interface document: this project provides nothing"}
                </span>
              </div>
              {all.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState
                    title="No contract yet"
                    message="A contract appears here once the interface document publishes one, the project consumes one in an ecosystem, or an issue waits on a version of one."
                  />
                </div>
              ) : (
                <GroupedList
                  ariaLabel="Contracts"
                  groups={groups}
                  fold={fold}
                  row={row}
                  selected={peek.open}
                  onPeek={(k) => peek.set(k === peek.open ? null : k)}
                  empty="Nothing matches this search."
                  columns={COLUMNS}
                />
              )}
            </div>
            {peek.open ? <ContractPeek key={peek.open} projectId={projectId} slug={slug} contractRef={peek.open} peek={peek} onOpenFull={() => openFull(peek.open as string)} /> : null}
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}
