import type { ReactNode } from "react";
import { ForgeMascot } from "./forge-mascot";
import { assetPath } from "@/lib/asset";

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
        style={{ fontSize: "var(--text-13)", fontWeight: 500, color: done ? "var(--green-600)" : "var(--fg-muted)" }}
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
        <img className="fm-breathe" src={assetPath("/forge-mark-180.png")} width={72} height={72} alt="Forge" />
      </div>
      <div className="fg-h2" style={{ fontWeight: 800 }}>Forge</div>
      <span className="inline-flex items-center gap-2 font-mono" style={{ fontSize: "var(--text-12-5)", color: "var(--fg-muted)" }}>
        <span className="forge-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: "var(--accent)" }} />
        {label}
      </span>
    </div>
  );
}