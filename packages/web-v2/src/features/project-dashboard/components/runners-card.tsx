"use client";

import { useRouter } from "next/navigation";
import { Badge, Button, HealthDot, Icon } from "@/design";
import type { RunnersSummary } from "../derive";
import { plural, type ReadState, unreadStatement } from "../shape";
import { DashboardSection, EmptyLine, RowList, unreadSection } from "./dashboard-section";

const PLATFORM_LABEL: Record<string, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };

export function RunnersCard({
  summary,
  slug,
  read,
  activity,
}: {
  summary: RunnersSummary;
  slug: string;
  /** The project's runners read; until it is in, "none bound" is not said. */
  read?: ReadState;
  /** The queue, active-runner and sessions reads; until all are in, no runner is called idle or busy. */
  activity?: ReadState;
}) {
  const router = useRouter();
  const { lines, onlineCount, total } = summary;
  const activityUnread = activity !== undefined && activity.read !== "ok";
  const activityStatement = activity ? unreadStatement("What the runners are doing", activity) : null;
  const unread = unreadSection("Runners", "The project's runners", read, true);
  if (unread) return unread;

  if (total === 0) {
    return (
      <EmptyLine
        title="Runners"
        status="none bound"
        action={
          <Button size="sm" variant="secondary" onClick={() => router.push(`/projects/${slug}/settings?tab=runners`)}>
            Bind a runner
          </Button>
        }
      />
    );
  }

  return (
    <DashboardSection
      title="Runners"
      aside={
        <span className="font-mono text-sm font-semibold tabular-nums text-fg">
          {onlineCount}/{total} online
        </span>
      }
    >
      <RowList>
        {lines.map((r) => (
          <li key={r.id} className="flex items-center gap-2.5 py-1.5">
            <HealthDot health={r.limit ? r.limit.health : r.online ? "healthy" : "idle"} withLabel={false} />
            <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{r.name}</span>
            <span className="fg-caption flex-none text-subtle">{PLATFORM_LABEL[r.platform] ?? r.platform}</span>
            {r.limit ? (
              <Badge tone={r.limit.health === "down" ? "red" : "amber"}>
                <span className="inline-flex items-center gap-1">
                  <Icon name="alert" size={10} />
                  {r.limit.active && r.limit.resetText ? r.limit.resetText : r.limit.label}
                </span>
              </Badge>
            ) : r.activeIssueRef ? (
              // Live: which issue (+ stage) this runner is executing now.
              <span
                className="fg-caption flex-none text-right font-semibold tabular-nums"
                style={{ color: "var(--cobalt-700)" }}
              >
                {r.activeIssueRef}
                {r.activeStage ? ` · ${r.activeStage}` : ""}
              </span>
            ) : activityUnread && r.online ? (
              <span className="fg-caption flex-none text-right text-subtle">activity not read</span>
            ) : (
              <span
                className="fg-caption min-w-12 flex-none text-right font-semibold"
                style={{ color: r.busy ? "var(--cobalt-700)" : "var(--fg-subtle)" }}
              >
                {r.draining
                  ? "draining"
                  : r.online
                    ? r.sessions > 0
                      ? plural(r.sessions, "session", "sessions")
                      : r.busy
                        ? "busy"
                        : "idle"
                    : "offline"}
              </span>
            )}
          </li>
        ))}
      </RowList>
      {activityStatement && (
        <p role={activity?.read === "failed" ? "alert" : "status"} data-testid="runners-activity-unread" className="fg-caption mt-1 text-subtle">
          {activityStatement}
        </p>
      )}
      <div className="mt-1 flex items-center gap-4 border-t border-line-subtle pt-2">
        <button
          type="button"
          onClick={() => router.push(`/projects/${slug}/agents`)}
          className="fg-caption inline-flex items-center gap-1 text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          Agents
          <Icon name="arrowRight" size={13} />
        </button>
        <button
          type="button"
          onClick={() => router.push(`/projects/${slug}/settings?tab=runners`)}
          className="fg-caption inline-flex items-center gap-1 text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          Runners
          <Icon name="arrowRight" size={13} />
        </button>
      </div>
    </DashboardSection>
  );
}
