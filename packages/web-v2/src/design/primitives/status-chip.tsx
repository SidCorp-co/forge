import { STATUS_META, type StatusKey } from "@/design/status";
import { Icon } from "@/design/icons/icon";
import { enumLabel } from "@/design/vocabulary";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

export type StatusDomain = "issue" | "session";

export interface StatusChipProps {
  status: StatusKey;
  /** When running, append the active pipeline stage, read as words: `Running · Code`. */
  stage?: string;
  size?: "sm" | "md";
  /** Status vocabulary this chip belongs to. Defaults to `issue`. */
  domain?: StatusDomain;
  label?: string;
  /** Issue domain only: a mark drawn in the dot's place (the status badge legend), so the status
   *  is not told by colour alone. Drawn by CSS, so it never joins the chip's text. */
  glyph?: string;
  /** The chip's tooltip; defaults to its text. */
  title?: string;
}

/** Execution-vocabulary overrides for the `session` domain so an agent run reads
 *  as "Completed / Stalled / Idle" rather than the issue-lifecycle "Done /
 *  Zombie / Paused" (`common.sessionKey.*`). Keys not listed fall back to the shared `common.statusKey.*`. */
const SESSION_WORDS: ReadonlySet<StatusKey> = new Set<StatusKey>(["done", "zombie", "paused", "passed", "waiting", "archived"]);

export function StatusChip({
  status,
  stage,
  size = "md",
  domain = "issue",
  label,
  glyph,
  title,
}: StatusChipProps) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const known = STATUS_META[status] ? status : "queued";
  const m = STATUS_META[known];
  const isRunning = status === "running";
  const isSession = domain === "session";
  const word = t(`${isSession && SESSION_WORDS.has(known) ? "common.sessionKey" : "common.statusKey"}.${known}` as ProductCopyKey);
  const baseLabel = label ?? word;
  // ISS-67: the stage is a stored job type, so it reads through the jobType labels, never raw.
  const text = stage && isRunning ? `${baseLabel} · ${enumLabel("jobType", stage, language)}` : baseLabel;
  const mono = isSession;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap font-semibold ${
        isSession ? "rounded-md" : "rounded-pill"
      }`}
      style={{
        color: m.fg,
        background: m.bg,
        padding: size === "sm" ? "3px 8px" : "4px 10px",
        fontSize: size === "sm" ? 11.5 : 12.5,
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        border: isSession ? `1px solid ${m.dot}` : "none",
      }}
    >
      {isSession ? (
        <Icon
          name="agent"
          size={size === "sm" ? 11 : 12}
          className={isRunning ? "forge-pulse" : ""}
          style={{ color: m.dot }}
        />
      ) : glyph ? (
        <span
          aria-hidden
          data-glyph={glyph}
          className={`leading-none before:content-[attr(data-glyph)] ${isRunning ? "forge-pulse" : ""}`}
          style={{ color: m.dot, fontSize: size === "sm" ? 10 : 11 }}
        />
      ) : (
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
      )}
      <span className="max-w-[22ch] truncate" title={title ?? text}>
        {text}
      </span>
    </span>
  );
}
