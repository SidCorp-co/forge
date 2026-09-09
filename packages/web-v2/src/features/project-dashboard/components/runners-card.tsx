"use client";

// cm:why no utilization% and deliberately not the rich fleet strip — utilization is not stored (ISS-378) and the detail belongs on the two screens this card links out to
// cm:edge contract -> packages/web-v2/src/features/project-dashboard/derive.ts — `runnersSummary` decides WHOSE runners these are; its guard is the one that keeps this card from claiming a project has none
import { useRouter } from "next/navigation";
import { Badge, Card, CardContent, HealthDot, Icon } from "@/design";
import type { RunnersSummary } from "../derive";

const PLATFORM_LABEL: Record<string, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };

export function RunnersCard({ summary, slug }: { summary: RunnersSummary; slug: string }) {
  const router = useRouter();
  const { lines, onlineCount, total } = summary;

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="server" size={16} className="text-subtle" />
          <h3 className="fg-h3">Runners</h3>
        </div>
        <span className="font-mono text-sm font-semibold tabular-nums text-fg">
          {onlineCount}/{total} online
        </span>
      </div>
      <p className="fg-caption border-b border-line-subtle px-5 py-2 text-subtle">
        Runners bound to this project
      </p>
      <CardContent className="flex-1">
        {total === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">
            No runners bound to this project yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {lines.map((r) => (
              <li key={r.id} className="flex items-center gap-2.5 px-0.5 py-1">
                <HealthDot
                  health={r.limit ? r.limit.health : r.online ? "healthy" : "idle"}
                  withLabel={false}
                />
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
                ) : (
                  <span
                    className="fg-caption min-w-12 flex-none text-right font-semibold"
                    style={{ color: r.busy ? "var(--cobalt-700)" : "var(--fg-subtle)" }}
                  >
                    {r.draining ? "draining" : r.online ? (r.busy ? "busy" : "idle") : "offline"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <div className="flex items-center gap-4 border-t border-line-subtle px-5 py-2.5">
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
    </Card>
  );
}
