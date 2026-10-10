"use client";

// Answer chips: one pick or several from a short list, each a pill that reads pressed. Base UI
// ToggleGroup and Toggle as documented, so the roving focus, arrow keys and pressed state are the
// primitive's. A chip may carry a trailing mark (an "Inferred" note) beside its label.

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface ChoiceChip {
  value: string;
  label: ReactNode;
  /** Drawn after the label, inside the chip. */
  mark?: ReactNode;
}

export interface ChoiceChipsProps {
  options: ChoiceChip[];
  /** The pressed values; one at most unless `multiple`. */
  value: string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  /** What assistive tech reads for the group. */
  label: string;
  /** `ai` tints the pressed chip as the agent's, for an accept/reject on its proposal. */
  tone?: "default" | "ai";
  className?: string;
}

export function ChoiceChips({ options, value, onChange, multiple = false, label, tone = "default", className }: ChoiceChipsProps) {
  return (
    <ToggleGroup
      aria-label={label}
      multiple={multiple}
      value={value}
      onValueChange={(next) => onChange(next as string[])}
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {options.map((o) => (
        <Toggle
          key={o.value}
          value={o.value}
          className={cn(
            "inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-pill border border-line bg-surface px-2.5 py-0.5 text-left text-12 font-medium text-fg transition-colors",
            "hover:border-line-strong focus-visible:outline-none focus-visible:shadow-focus",
            tone === "ai" ? "data-pressed:border-ai-9 data-pressed:bg-ai-bg data-pressed:text-ai" : "data-pressed:border-link data-pressed:bg-sel",
          )}
        >
          <span className="min-w-0">{o.label}</span>
          {o.mark}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
