"use client";

// Context rail for the run thread: compact PipelineTracker + run stats + a
// files-changed list derived from edit-tool blocks across turns (no diff REST
// endpoint exists). Collapses into a SlideOver below `lg` (handled by the
// parent). Kit-only tokens; cost/model are not on the session row → show "—".
import { HealthDot, Icon, MonoTag, PipelineTracker, Stat, StatusChip, useElapsed } from "@/design";
import {
  deriveSessionDisplayStatus,
  deriveStage,
  statusToChip,
  statusToRun,
  type SessionRow,
} from "@/features/sessions/types";
import { useDevices } from "@/features/runners/hooks";
import { deviceHealth } from "@/features/runners/types";
import { deriveFilesChanged, type ConversationItem } from "../types";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtNum(n: number | undefined): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      {/* Sticky within the rail's own scroll so the section label stays visible
          while a long list (e.g. Files changed) scrolls past (ISS-351). */}
      <h3 className="fg-caption sticky top-0 z-10 mb-2 bg-app py-1 uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ContextRail({ session, items }: { session: SessionRow; items: ConversationItem[] }) {
  const display = deriveSessionDisplayStatus(session);
  const stage = deriveStage(session.metadata);
  const live = display === "running" || display === "stalled";
  const startMs = session.startedAt ? new Date(session.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);
  const duration = !startMs
    ? "—"
    : live
      ? elapsed
      : formatDuration(new Date(session.updatedAt).getTime() - startMs);

  const usage = session.usage ?? {};
  const files = deriveFilesChanged(items);
  const isPipeline = session.metadata?.type === "pipeline" || session.metadata?.type === "pm";

  // Resolve the runner the session is bound to. The device may not be in the
  // viewer's owner-scoped list (different owner) → fall back to the short id.
  const devicesQ = useDevices();
  const device = session.deviceId
    ? devicesQ.data?.find((d) => d.id === session.deviceId)
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      {session.deviceId && (
        <Section title="Runner">
          {device ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 overflow-hidden">
                <Icon name="server" size={14} className="flex-none text-subtle" />
                <span className="flex-1 truncate fg-body-sm" title={device.name}>
                  {device.name}
                </span>
                <HealthDot health={deviceHealth(device.status)} />
              </div>
              <span className="fg-caption">
                {PLATFORM_LABEL[device.platform] ?? device.platform}
                {device.agentVersion ? ` · v${device.agentVersion}` : ""}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 overflow-hidden">
              <Icon name="server" size={14} className="flex-none text-subtle" />
              <MonoTag hue="neutral">{session.deviceId.slice(0, 8)}</MonoTag>
            </div>
          )}
        </Section>
      )}

      {isPipeline && (
        <Section title="Pipeline">
          <PipelineTracker stage={stage} status={statusToRun(display)} variant="compact" />
          <div className="mt-3">
            <StatusChip status={statusToChip(display)} stage={stage} size="sm" />
          </div>
        </Section>
      )}

      <Section title="Run stats">
        <div className="flex flex-col gap-2.5">
          {!isPipeline && <StatusChip status={statusToChip(display)} stage={stage} size="sm" />}
          <Stat icon="activity" title="Turns">{usage.turns ?? "—"} turns</Stat>
          <Stat icon="clock" title="Duration">{duration}</Stat>
          <Stat icon="cpu" title="Context window used">{fmtNum(usage.contextUsed)} ctx</Stat>
          <Stat icon="arrowRight" title="Tokens in / out">
            {fmtNum(usage.inputTotal)} / {fmtNum(usage.outputTotal)} tok
          </Stat>
          <Stat icon="dollar" title="Cost not tracked on this session">— cost</Stat>
        </div>
      </Section>

      <Section title={`Files changed${files.length ? ` · ${files.length}` : ""}`}>
        {files.length === 0 ? (
          <p className="fg-caption">No file edits yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 overflow-hidden">
                <Icon name={f.isNew ? "plus" : "branch"} size={13} className="flex-none text-subtle" />
                <span className="flex-1 truncate font-mono" style={{ fontSize: 11.5 }} title={f.path}>
                  {f.path}
                </span>
                {f.added > 0 && (
                  <span className="flex-none font-mono" style={{ fontSize: 11, color: "var(--green-600)" }}>+{f.added}</span>
                )}
                {f.removed > 0 && (
                  <span className="flex-none font-mono" style={{ fontSize: 11, color: "var(--red-600)" }}>-{f.removed}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
