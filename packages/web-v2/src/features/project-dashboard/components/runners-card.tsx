"use client";

// Compact runners card (ISS-379, AC#5). `N/M online` + one line per runner
// (device · platform · busy/idle). NO utilization% (not stored — deferred to
// ISS-378) and deliberately NOT the rich ISS-378 fleet strip: it links out to
// the Agents / Runners screens for detail.
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
      {/* ISS-528: runners are org-shared infra (ISS-477); there is no
          project→runner assignment model, so the list is labelled org-wide
          rather than implying it is exclusive to this project. The per-runner
          busy/idle below IS already scoped to this project via /queue-stats. */}
      <p className="fg-caption border-b border-line-subtle px-5 py-2 text-subtle">
        Org runners available to this project
      </p>
      <CardContent className="flex-1">
        {total === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">No runners paired yet.</p>
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
                ) : (
                  <span
                    className="fg-caption w-12 flex-none text-right font-semibold"
                    style={{ color: r.busy ? "var(--cobalt-700)" : "var(--fg-subtle)" }}
                  >
                    {r.online ? (r.busy ? "busy" : "idle") : "offline"}
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
