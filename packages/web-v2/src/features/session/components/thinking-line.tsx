"use client";

// The one renderer for a turn's pauses (ISS-1079). Three shapes meet here and
// the reader is shown the same line by all of them: readable reasoning from the
// assistant providers, a pause those providers could not read because the
// provider encrypted it, and a bare count — the Claude Code derive's
// `thinkingCount`, which is the only producer of that form. Kit-only: imports
// from @/design, semantic tokens, no hex.
import { useState } from "react";
import { Icon } from "@/design";

/** *4s* · *0.4s* · *840ms* — short enough to sit inside a label. */
function spent(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const s = ms / 1_000;
  if (s >= 10) return `${Math.round(s)}s`;
  // cm:why a trailing `.0` is trimmed rather than kept for alignment: this sits inside a sentence a
  // person reads, and "Thought for 4.0s" claims a precision the clock behind it does not have.
  const one = s.toFixed(1);
  return `${one.endsWith(".0") ? one.slice(0, -2) : one}s`;
}

/**
 * The collapsed label, in its four forms.
 */
// cm:why the duration wins over the count when both are present: a turn whose
// reasoning was readable is described better by how long it took than by how
// many times it paused, and the two are never the same fact — `durationMs`
// belongs to one block, `count` to the whole turn.
export function thinkingLabel(b: {
  text?: string | undefined;
  durationMs?: number | undefined;
  count?: number | undefined;
  streaming?: boolean | undefined;
}): string {
  if (b.streaming === true && b.durationMs === undefined) return "Thinking…";
  if (b.durationMs !== undefined) return `Thought for ${spent(b.durationMs)}`;
  if (b.count !== undefined && b.count > 0) {
    return b.count === 1 ? "Thought once" : `Thought ${b.count} times`;
  }
  return "Thought";
}

/**
 * One pause, collapsed to a line.
 */
// cm:guard the expander exists ONLY where there is text to expand onto. A pause
// with nothing to read — every Claude Code turn's count, and every block a
// provider encrypted — renders as a static line: an expandable "Thought" that
// opens onto nothing is the affordance defect this component was specified to
// refuse, and a disabled-looking chevron is the same defect wearing a hint.
export function ThinkingLine({
  text,
  durationMs,
  count,
  streaming,
}: {
  text?: string | undefined;
  durationMs?: number | undefined;
  count?: number | undefined;
  streaming?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const label = thinkingLabel({ text, durationMs, count, streaming });
  const expandable = typeof text === "string" && text.length > 0;

  if (!expandable) {
    return (
      <div data-testid="thinking-line" className="flex items-center gap-1.5 text-subtle" style={{ fontSize: 12 }}>
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
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit items-center gap-1.5 rounded text-subtle hover:text-default"
        style={{ fontSize: 12 }}
      >
        <Icon name="cpu" size={12} />
        <span>{label}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      {open && (
        <div
          data-testid="thinking-line-text"
          className="whitespace-pre-wrap border-l border-line-subtle pl-2 text-subtle"
          style={{ fontSize: 12 }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
