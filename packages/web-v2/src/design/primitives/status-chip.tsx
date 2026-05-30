import { STATUS_META, type StatusKey } from "@/design/status";

export interface StatusChipProps {
  status: StatusKey;
  /** When running, append the active pipeline stage, e.g. `running · code`. */
  stage?: string;
  size?: "sm" | "md";
}

export function StatusChip({ status, stage, size = "md" }: StatusChipProps) {
  const m = STATUS_META[status] ?? STATUS_META.queued;
  const isRunning = status === "running";
  const text = stage && isRunning ? `running · ${stage}` : m.label;
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill font-semibold"
      style={{
        color: m.fg,
        background: m.bg,
        padding: size === "sm" ? "3px 8px" : "4px 10px",
        fontSize: size === "sm" ? 11.5 : 12.5,
        fontFamily: stage && isRunning ? "var(--font-mono)" : "var(--font-sans)",
      }}
    >
      <span
        className={isRunning ? "forge-pulse" : ""}
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: m.dot,
          boxShadow: isRunning ? `0 0 0 3px ${m.bg}` : "none",
        }}
      />
      {text}
    </span>
  );
}
