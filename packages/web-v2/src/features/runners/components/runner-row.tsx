"use client";

// One runner row inside a device card: status dot · project · model · activity,
// with a Claude-quota Stat and an action menu (refresh quota / exclude / include).
import { HealthDot, IconButton, Menu, MonoTag, Stat, type MenuItem } from "@/design";
import { useExcludeRunner, useIncludeRunner, useRefreshQuota } from "../hooks";
import { runnerActivity, runnerHealth, runnerModel, type RunnerDetail } from "../types";

function quotaLabel(r: RunnerDetail): string | null {
  const q = r.config?.quota;
  if (!q || q.remaining == null) return null;
  return q.limit != null ? `${q.remaining}/${q.limit}` : String(q.remaining);
}

export function RunnerRow({
  runner,
  projectName,
}: {
  runner: RunnerDetail;
  projectName: string;
}) {
  const refreshQuota = useRefreshQuota();
  const exclude = useExcludeRunner();
  const include = useIncludeRunner();
  const quota = quotaLabel(runner);

  const items: MenuItem[] = [
    { label: "Refresh quota", icon: "rerun", onSelect: () => refreshQuota.mutate(runner.id) },
  ];
  if (runner.status === "disabled") {
    items.push({ label: "Re-enable", icon: "play", onSelect: () => include.mutate(runner.id) });
  } else {
    items.push({ label: "Exclude", icon: "stop", danger: true, onSelect: () => exclude.mutate(runner.id) });
  }

  return (
    <div className="flex items-center gap-2.5 rounded-md border border-line-subtle bg-sunken px-3 py-2.5">
      <HealthDot health={runnerHealth(runner.status)} withLabel={false} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="fg-body-sm truncate text-fg">{projectName}</span>
          <MonoTag hue="cobalt">{runnerModel(runner)}</MonoTag>
        </div>
        <p className="fg-caption mt-0.5 truncate">
          {runner.lastError ? `Error: ${runner.lastError}` : runnerActivity(runner)}
        </p>
      </div>
      {quota && (
        <Stat icon="dollar" title="Claude quota remaining / limit">
          {quota}
        </Stat>
      )}
      <Menu
        align="right"
        items={items}
        trigger={<IconButton icon="more" aria-label="Runner actions" className="min-h-11 min-w-11" />}
      />
    </div>
  );
}
