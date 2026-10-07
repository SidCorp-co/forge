"use client";

// The one renderer for a turn's pauses (ISS-1079). Three shapes meet here and
// the reader is shown the same line by all of them: readable reasoning from the
// assistant providers, a pause those providers could not read because the
// provider encrypted it, and a bare count — the Claude Code derive's
// `thinkingCount`, which is the only producer of that form. Kit-only: imports
// from @/design, semantic tokens, no hex.
import { Icon } from "@/design";
import { useCopy, useCopyLocale } from "@/lib/i18n/interface-language";
import { type Copy, productCopy } from "@/lib/i18n/product-copy";
import { useDisclosure } from "../disclosure";

/** *4s* · *0.4s* · *840ms* — short enough to sit inside a label; the decimal mark is the locale's. */
function spent(ms: number, locale: string): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const s = ms / 1_000;
  if (s >= 10) return `${Math.round(s)}s`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Number(s.toFixed(1)))}s`;
}

/**
 * The collapsed label, in its four forms.
 */
export function thinkingLabel(b: {
  text?: string | undefined;
  durationMs?: number | undefined;
  count?: number | undefined;
  streaming?: boolean | undefined;
}, t: Copy = productCopy(), locale = "en-GB"): string {
  if (b.streaming === true && b.durationMs === undefined) return t("sessions.think.streaming");
  if (b.durationMs !== undefined) return t("sessions.think.for", { d: spent(b.durationMs, locale) });
  if (b.count !== undefined && b.count > 0) {
    return b.count === 1 ? t("sessions.think.once") : t("sessions.think.times", { n: b.count });
  }
  return t("sessions.think.plain");
}

/**
 * One pause, collapsed to a line.
 */
export function ThinkingLine({
  text,
  durationMs,
  count,
  streaming,
  blockKey,
}: {
  text?: string | undefined;
  durationMs?: number | undefined;
  count?: number | undefined;
  streaming?: boolean | undefined;
  /** This pause's identity in the thread's disclosure state (ISS-1083). */
  blockKey?: string | undefined;
}) {
  const [open, toggle] = useDisclosure(blockKey);
  const t = useCopy();
  const locale = useCopyLocale();
  const label = thinkingLabel({ text, durationMs, count, streaming }, t, locale);
  const expandable = typeof text === "string" && text.length > 0;

  if (!expandable) {
    return (
      <div data-testid="thinking-line" className="flex items-center gap-1.5 text-subtle" style={{ fontSize: "var(--text-12)" }}>
        <Icon name="cpu" size={12} />
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div data-testid="thinking-line" className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="thinking-line-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-fit items-center gap-1.5 rounded text-subtle hover:text-default"
        style={{ fontSize: "var(--text-12)" }}
      >
        <Icon name="cpu" size={12} />
        <span>{label}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      {open && (
        <div
          data-testid="thinking-line-text"
          className="whitespace-pre-wrap border-l border-line-subtle pl-2 text-subtle"
          style={{ fontSize: "var(--text-12)" }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
