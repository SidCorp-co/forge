import type { ReactNode } from "react";
import { ForgeMascot } from "./forge-mascot";

/** Signature whole-view loader — the mascot with its pipeline ring + a live
    telemetry line. Use for cold project loads / reconnects. */
export function ProjectLoader({
  label, progress = 0.5, done = false, size = 150,
}: { label: ReactNode; progress?: number; done?: boolean; size?: number }) {
  return (
    <div className="flex flex-col items-center gap-5">
      <ForgeMascot size={size} mode="both" ring progress={progress} flicker />
      <span
        className="inline-flex items-center gap-2 font-mono"
        style={{ fontSize: 13, fontWeight: 500, color: done ? "var(--green-600)" : "var(--fg-muted)" }}
      >
        <span
          className={done ? "" : "forge-pulse"}
          style={{ width: 7, height: 7, borderRadius: 999, background: done ? "var(--green-500)" : "var(--accent)" }}
        />
        {label}
      </span>
    </div>
  );
}

/** Cold-boot splash — floating mascot + warm glow + booting line. */
export function ColdBoot({ label = "booting control plane…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3.5">
      <div className="relative grid place-items-center">
        <div
          style={{
            position: "absolute", inset: "-30%", borderRadius: "50%",
            background: "radial-gradient(circle, rgba(241,90,43,0.16), rgba(241,90,43,0) 62%)",
            animation: "fm-glow 2.6s var(--ease-in-out) infinite",
          }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="fm-breathe" src="/forge-mark-180.png" width={72} height={72} alt="Forge" />
      </div>
      <div className="fg-h2" style={{ fontWeight: 800 }}>Forge</div>
      <span className="inline-flex items-center gap-2 font-mono" style={{ fontSize: 12.5, color: "var(--fg-muted)" }}>
        <span className="forge-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent)" }} />
        {label}
      </span>
    </div>
  );
}

/** Inline "agent is working" row — mascot-32 with a pulsing ring + elapsed. */
export function AgentWorking({ label, elapsed }: { label: ReactNode; elapsed?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5 shadow-xs">
      <span className="relative flex-none" style={{ width: 30, height: 30 }}>
        <span
          className="fm-ringpulse"
          style={{ position: "absolute", inset: -4, borderRadius: 999, border: "2px solid var(--flame-300)" }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/forge-mark-32.png" width={30} height={30} alt="" />
      </span>
      <span className="fg-body-sm text-fg">{label}</span>
      {elapsed && <span className="ml-auto font-mono text-subtle" style={{ fontSize: 12 }}>{elapsed}</span>}
    </div>
  );
}

/** Reassuring offline/reconnecting banner with a pulsing mark. */
export function ReconnectingBanner({ label = "Runner offline — reconnecting…" }: { label?: string }) {
  return (
    <div
      className="inline-flex items-center gap-2.5 rounded-md px-3.5 py-2.5 font-semibold"
      style={{ background: "var(--amberw-50)", border: "1px solid #F6D9A0", color: "var(--amberw-600)", fontSize: 13.5 }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="forge-pulse" src="/forge-mark-32.png" width={22} height={22} alt="" />
      {label}
    </div>
  );
}
