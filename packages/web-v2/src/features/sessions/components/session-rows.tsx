import { useRouter } from "next/navigation";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import {
  Badge,
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
import {
  type StuckRuns,
  deriveSessionDisplayStatus,
  sessionStep,
  isRetryable,
  formatCost,
  formatDuration,
  formatShortTime,
  type AgentSessionDisplayStatus,
  type SessionRow,
} from "../types";
import { RunnerCell, SessionIdentity, SessionKindTag, StatusCell } from "./session-cells";
import { OWNER_INDENT_PX, type TreeRow } from "./session-tree";

/** The filtered page as a dense table from tablet up, and as stacked cards on a phone. */
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
    <>
      {/* Desktop / tablet: dense table. */}
      <div className="hidden md:block">
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
              <SessionTableRow
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
      </div>

      {/* Mobile: a flush list — no horizontal page scroll. */}
      <div className="divide-y divide-line-subtle border-y border-line-subtle md:hidden">
        {treeRows.map(({ row, depth }) => (
          <SessionMobileRow
            key={row.id}
            row={row}
            depth={depth}
            slug={slug}
            deviceName={row.deviceId ? deviceNameById.get(row.deviceId) : undefined}
            now={now}
            stuck={stuck}
            actions={actions}
          />
        ))}
      </div>
    </>
  );
}

interface RowProps {
  row: SessionRow;
  slug?: string;
  deviceName?: string;
  now: number;
  stuck: StuckRuns;
  actions: RowActions;
  /** How far under its owner this row sits, in the list as filtered. */
  depth: number;
}

/** A row's display state, its duration and the route it opens. */
function useRowView({ row, slug, stuck }: RowProps) {
  const router = useRouter();
  const t = useCopy();
  const display = deriveSessionDisplayStatus(row, stuck);
  const live = display === "running" || display === "stalled";
  const startMs = row.startedAt ? new Date(row.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);
  const duration = !startMs
    ? "—"
    : live
      ? elapsed
      : formatDuration(new Date(row.updatedAt).getTime() - startMs, t);
  const stage = sessionStep(row.metadata) ?? undefined;
  const open = slug ? () => router.push(`/projects/${slug}/agents/${row.id}`) : undefined;
  return { display, duration, stage, open };
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

function SessionTableRow(props: RowProps & {
  /** Whether anything in this list is owned by it. */
  hasChildren: boolean;
}) {
  const { row, slug, deviceName, now, stuck, actions, depth, hasChildren } = props;
  const { display, duration, stage, open } = useRowView(props);
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const t = useCopy();
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
            <span className="text-11 text-muted" title={t("sessions.owns")}>
              &#8226;
            </span>
          )}
        </div>
      </TD>
      <TD className="max-w-[260px]">
        <SessionIdentity row={row} slug={slug} onOpen={open} />
      </TD>
      <TD className="max-w-[160px]">
        <RunnerCell row={row} deviceName={deviceName} display={display} now={now} stuck={stuck} />
      </TD>
      <TD className="whitespace-nowrap font-mono text-muted">{formatShortTime(row.startedAt ?? row.dispatchedAt, time.dateTime)}</TD>
      <TD className="text-right font-mono text-muted">{row.usage?.turns != null ? time.number(row.usage.turns) : "—"}</TD>
      <TD className="text-right font-mono text-muted">{duration}</TD>
      <TD className="text-right font-mono text-muted">{formatCost(row.estimatedCost, language)}</TD>
      <TD>
        <StatusCell row={row} display={display} stage={stage} now={now} stuck={stuck} />
      </TD>
      <TD className="text-right">
        <RowActionsMenu row={row} display={display} actions={actions} />
      </TD>
    </TR>
  );
}

function SessionMobileRow(props: RowProps) {
  const { row, slug, deviceName, now, stuck, actions, depth } = props;
  const { display, duration, stage, open } = useRowView(props);
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  return (
    // The same edge the table shows, at a width a phone can carry: the nesting
    // has to survive the narrow layout or the tree is a desktop-only claim.
    <div className="py-3">
      <div
        className="flex items-start justify-between gap-3"
        style={depth > 0 ? { paddingLeft: depth * OWNER_INDENT_PX } : undefined}
      >
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-1.5">
            {depth > 0 && (
              <span aria-hidden className="text-muted select-none">
                &#8735;
              </span>
            )}
            <SessionKindTag row={row} />
          </div>
          <SessionIdentity row={row} slug={slug} onOpen={open} />
        </div>
        <RowActionsMenu row={row} display={display} actions={actions} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <StatusCell row={row} display={display} stage={stage} now={now} stuck={stuck} />
        <div className="flex items-center gap-3">
          <Badge tone="neutral">{t("sessions.turnsCount", { n: time.number(row.usage?.turns ?? 0) })}</Badge>
          <span className="fg-mono text-muted">{duration}</span>
          <span className="fg-mono text-muted">{formatCost(row.estimatedCost, language)}</span>
        </div>
      </div>
      <div className="fg-caption mt-1.5 text-subtle">{t("sessions.startedAt", { at: formatShortTime(row.startedAt ?? row.dispatchedAt, time.dateTime) })}</div>
      {row.deviceId && (
        <div className="mt-2.5">
          <RunnerCell row={row} deviceName={deviceName} display={display} now={now} stuck={stuck} />
        </div>
      )}
    </div>
  );
}
