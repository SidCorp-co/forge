import { useRouter } from "next/navigation";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import {
  IconButton,
  Menu,
  MonoTag,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  type MenuItem,
  useElapsed,
} from "@/design";
import { type StuckRuns, deriveSessionDisplayStatus, sessionStep, isRetryable, type AgentSessionDisplayStatus, type SessionRow } from "../types";
import { RunnerCell, SessionIdentity, SessionKindTag, StatusCell } from "./session-cells";
import { OWNER_INDENT_PX, type TreeRow } from "./session-tree";

/** The filtered page as one dense table; at phone width it scrolls sideways inside itself. */
export function SessionList({
  treeRows,
  slug,
  deviceNameById,
  now,
  stuck,
  actions,
}: {
  treeRows: TreeRow<SessionRow>[];
  slug?: string;
  deviceNameById: Map<string, string>;
  now: number;
  stuck: StuckRuns;
  actions: RowActions;
}) {
  const t = useCopy();
  return (
    <Table>
      <THead>
        <TR>
          <TH>{t("sessions.col.session")}</TH>
          <TH>{t("sessions.col.issueAgent")}</TH>
          <TH>{t("sessions.col.runner")}</TH>
          <TH>{t("sessions.col.started")}</TH>
          <TH className="text-right">{t("sessions.col.turns")}</TH>
          <TH className="text-right">{t("sessions.col.duration")}</TH>
          <TH className="text-right">{t("sessions.col.cost")}</TH>
          <TH>{t("sessions.col.status")}</TH>
          <TH className="text-right">{t("sessions.col.actions")}</TH>
        </TR>
      </THead>
      <TBody>
        {treeRows.map(({ row, depth, hasChildren }) => (
          <SessionTableEntry
            key={row.id}
            row={row}
            depth={depth}
            hasChildren={hasChildren}
            slug={slug}
            deviceName={row.deviceId ? deviceNameById.get(row.deviceId) : undefined}
            now={now}
            stuck={stuck}
            actions={actions}
          />
        ))}
      </TBody>
    </Table>
  );
}

interface MutationLike {
  mutate: (id: string) => void;
}
export interface RowActions {
  cancel: MutationLike;
  retry: MutationLike;
  rerun: MutationLike;
  abort: MutationLike;
}

function buildMenuItems(row: SessionRow, display: AgentSessionDisplayStatus, a: RowActions, t: Copy): MenuItem[] {
  const items: MenuItem[] = [];
  const isLive = display === "running" || display === "stalled";
  const isQueued = row.status === "queued" || row.status === "idle";
  const isTerminal =
    display === "completed" ||
    display === "completed_via_recovery" ||
    display === "failed" ||
    display === "cancelled_stale" ||
    display === "cancelled";

  if (isLive || isQueued) {
    items.push({ label: t("sessions.action.cancel"), icon: "x", danger: true, onSelect: () => a.cancel.mutate(row.id) });
  }
  if (isLive || display === "idle") {
    items.push({ label: t("sessions.action.abort"), icon: "stop", onSelect: () => a.abort.mutate(row.id) });
  }
  if ((display === "failed" || display === "cancelled_stale") && isRetryable(row)) {
    items.push({ label: t("sessions.action.retry"), icon: "rerun", onSelect: () => a.retry.mutate(row.id) });
  }
  if (isTerminal) {
    items.push({ label: t("sessions.action.rerun"), icon: "rerun", onSelect: () => a.rerun.mutate(row.id) });
  }
  return items;
}

function RowActionsMenu({
  row,
  display,
  actions,
}: {
  row: SessionRow;
  display: AgentSessionDisplayStatus;
  actions: RowActions;
}) {
  const t = useCopy();
  const items = buildMenuItems(row, display, actions, t);
  if (items.length === 0) return <span className="fg-caption">—</span>;
  return (
    <Menu
      align="right"
      items={items}
      trigger={
        <IconButton icon="more" aria-label={t("sessions.action.menu")} className="min-h-11 min-w-11" />
      }
    />
  );
}

function SessionTableEntry({ row, slug, deviceName, now, stuck, actions, depth, hasChildren }: {
  row: SessionRow;
  slug?: string;
  deviceName?: string;
  now: number;
  stuck: StuckRuns;
  actions: RowActions;
  /** How far under its owner this row sits, in the list as filtered. */
  depth: number;
  /** Whether anything in this list is owned by it. */
  hasChildren: boolean;
}) {
  const router = useRouter();
  const time = useTimeFormat();
  const t = useCopy();
  const display = deriveSessionDisplayStatus(row, stuck);
  const live = display === "running" || display === "stalled";
  const startMs = row.startedAt ? new Date(row.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);
  const duration = !startMs ? "—" : live ? elapsed : time.duration(new Date(row.updatedAt).getTime() - startMs);
  const stage = sessionStep(row.metadata) ?? undefined;
  const open = slug ? () => router.push(`/projects/${slug}/agents/${row.id}`) : undefined;
  return (
    <TR>
      <TD>
        <div
          className="flex items-center gap-1.5"
          style={depth > 0 ? { paddingLeft: depth * OWNER_INDENT_PX } : undefined}
        >
          {depth > 0 && (
            <span aria-hidden className="text-muted select-none">
              &#8735;
            </span>
          )}
          {open ? (
            <button type="button" onClick={open} className="focus-visible:outline-none">
              <MonoTag hue="cobalt">{row.id.slice(0, 8)}</MonoTag>
            </button>
          ) : (
            <MonoTag hue="cobalt">{row.id.slice(0, 8)}</MonoTag>
          )}
          <SessionKindTag row={row} />
          {hasChildren && (
            <span className="text-12 text-muted" title={t("sessions.owns")}>
              &#8226;
            </span>
          )}
        </div>
      </TD>
      <TD className="max-w-65">
        <SessionIdentity row={row} slug={slug} onOpen={open} />
      </TD>
      <TD className="max-w-40">
        <RunnerCell row={row} deviceName={deviceName} display={display} now={now} stuck={stuck} />
      </TD>
      <TD className="whitespace-nowrap font-mono text-muted">{time.when(row.startedAt ?? row.dispatchedAt)}</TD>
      <TD className="text-right font-mono text-muted">{row.usage?.turns != null ? time.number(row.usage.turns) : "—"}</TD>
      <TD className="text-right font-mono text-muted">{duration}</TD>
      <TD className="text-right font-mono text-muted">{time.usd(row.estimatedCost)}</TD>
      <TD>
        <StatusCell row={row} display={display} stage={stage} now={now} stuck={stuck} />
      </TD>
      <TD className="text-right">
        <RowActionsMenu row={row} display={display} actions={actions} />
      </TD>
    </TR>
  );
}
