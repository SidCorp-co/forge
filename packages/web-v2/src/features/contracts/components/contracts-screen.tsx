
import { CONTRACT_ATTENTION_GROUPS, CONTRACT_ATTENTION_LABELS } from "@forge/contracts/contract-standing";
import { useRouter } from "@/lib/navigation/router";
import { type ReactNode } from "react";
import {
  EmptyState,
  EnumBadge,
  GroupedList,
  type ListGroup,
  ListLayout,
  type ListRowView,
  ListSearch,
  ListToolbar,
  PageTitle,
  rememberListOrigin,
  StatusBadge,
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
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { useContractStanding } from "../hooks";
import { CONTRACTS_LIST, contractHref } from "@/lib/routes/contracts";
import type { ContractStandingRow } from "../types";
import { versionLine, WindowText } from "./contract-bits";
import { ContractPeek } from "./contract-peek";

const GROUP_MODES = [
  { value: "attention" as const, label: "contracts.mode.attention" as const },
  { value: "direction" as const, label: "contracts.mode.direction" as const },
];
type GroupMode = (typeof GROUP_MODES)[number]["value"];

const modesIn = (t: Copy) => GROUP_MODES.map((m) => ({ value: m.value, label: t(m.label) }));

const columnsIn = (t: Copy) => ({ key: t("contracts.col.key"), title: t("contracts.col.title"), state: t("contracts.col.state"), meta: t("contracts.col.meta") });

function groupsOf(rows: ContractStandingRow[], mode: GroupMode, slug: string, t: Copy, label: (group: "contractAttention", g: string) => string): ListGroup<ContractStandingRow>[] {
  if (mode === "direction") {
    return [
      { id: "provided", label: t("contracts.providedBy", { project: slug }), tone: null, rows: rows.filter((r) => r.direction === "provided") },
      { id: "consumed", label: t("contracts.group.consumed"), tone: null, rows: rows.filter((r) => r.direction === "consumed") },
    ];
  }
  return CONTRACT_ATTENTION_GROUPS.map((g) => ({
    id: g,
    label: label("contractAttention", g),
    tone: CONTRACT_ATTENTION_LABELS[g].tone,
    collapsed: CONTRACT_ATTENTION_LABELS[g].collapsed,
    rows: rows.filter((r) => r.attentionGroup === g),
  }));
}

function factsLine(r: ContractStandingRow, t: Copy): ReactNode[] {
  const parts: ReactNode[] = [<EnumBadge key="kind" family="interfaceType" value={r.kind} />];
  parts.push(r.direction === "consumed" ? t("contracts.from", { project: r.provider.slug }) : t("contracts.provided"));
  parts.push(versionLine(r, t));
  if (r.direction === "provided" && r.consumers.total > 0) parts.push(`${t("contracts.consumersCount", { n: r.consumers.total })}${r.consumers.behind ? ` · ${t("contracts.consumersBehind", { n: r.consumers.behind })}` : ""}`);
  return parts;
}

const rowOf =
  (slug: string, t: Copy) =>
  (r: ContractStandingRow): ListRowView => ({
    key: r.ref,
    keyLabel: (
      <span className="whitespace-normal break-words" title={r.ref}>
        {r.slug}
      </span>
    ),
    href: contractHref(slug, r.ref),
    title: r.title,
    facts: factsLine(r, t),
    state: <StatusBadge family="contractState" value={r.state} />,
    waitingOn: <WaitingOn w={r.waitingOn} />,
    owner: <WindowText row={r} />,
    age: r.touchedAt ? { text: formatAge(r.touchedAt), title: t("contracts.lastVersionRecorded", { when: formatStamp(r.touchedAt) }) } : null,
    dim: r.attentionGroup === "steady" && r.state === "deprecated",
  });

export function ContractsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useContractStanding(projectId);
  const t = useCopy();
  const label = useLabel();
  const modes = modesIn(t);
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [mode, setMode] = useViewMode(GROUP_MODES);
  const text = params.get("q") ?? "";
  const fold = useGroupFold("web-v2:contracts-fold");

  const all = q.data?.contracts ?? [];
  const needle = text.trim().toLowerCase();
  const rows = needle ? all.filter((r) => `${r.ref} ${r.title} ${r.summary ?? ""}`.toLowerCase().includes(needle)) : all;
  const groups = groupsOf(rows, mode, slug, t, label);
  const visible = visibleRows(groups, fold).map((r) => r.ref);
  const peek = usePeek(visible, all.map((r) => r.ref));
  const row = rowOf(slug, t);

  const openFull = (key: string) => {
    rememberListOrigin(CONTRACTS_LIST);
    router.push(contractHref(slug, key));
  };
  usePeekKeys(peek, openFull);

  const title = <PageTitle after={<ViewModeSwitcher modes={modes} value={mode} onChange={setMode} placement="header" />}>{t("contracts.title")}</PageTitle>;
  return (
    <QueryBoundary query={q} loadingLabel={t("contracts.loading")} title={title} height="60vh" retry="always">
      {(data) => (
        <div className="grid min-h-full content-start bg-app" data-testid="contracts-screen">
          {title}
          <ListLayout
            peek={peek.open ? <ContractPeek key={peek.open} projectId={projectId} slug={slug} contractRef={peek.open} peek={peek} onOpenFull={() => openFull(peek.open as string)} /> : undefined}
          >
            <div className="min-w-0">
              <ListToolbar>
                <ViewModeSwitcher modes={modes} value={mode} onChange={setMode} placement="toolbar" />
                <ListSearch noun={t("contracts.searchNoun")} value={text} onChange={(v) => setParams({ q: v || null })} />
                <span className="ml-auto text-12 text-subtle">
                  {data.declared ? t("contracts.declared") : t("contracts.undeclared")}
                </span>
              </ListToolbar>
              {all.length === 0 ? (
                <div className="px-5 py-10">
                  <EmptyState message={t("contracts.empty.title")} />
                </div>
              ) : (
                <GroupedList
                  ariaLabel={t("contracts.title")}
                  groups={groups}
                  fold={fold}
                  row={row}
                  selected={peek.open}
                  onPeek={(k) => peek.set(k === peek.open ? null : k)}
                  empty={t("contracts.noMatch")}
                  columns={columnsIn(t)}
                />
              )}
            </div>
          </ListLayout>
        </div>
      )}
    </QueryBoundary>
  );
}
