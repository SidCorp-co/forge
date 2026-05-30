import { HEALTH_META, type HealthKey } from "@/design/status";

export interface HealthDotProps {
  health: HealthKey;
  withLabel?: boolean;
}

export function HealthDot({ health, withLabel = true }: HealthDotProps) {
  const m = HEALTH_META[health] ?? HEALTH_META.idle;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill font-semibold"
      style={{
        fontSize: 12,
        color: m.fg,
        padding: withLabel ? "3px 9px" : 0,
        background: withLabel ? m.bg : "transparent",
      }}
    >
      <span
        className={health === "attention" || health === "down" ? "forge-pulse" : ""}
        style={{ width: 7, height: 7, borderRadius: 999, background: m.dot }}
      />
      {withLabel && m.label}
    </span>
  );
}
