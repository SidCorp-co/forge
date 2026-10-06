"use client";

import { Badge, Button, Icon, Input, Popover, SegmentedControl, type SegmentOption } from "@/design";
import { useAssistantSetFilter } from "@/features/chat-dock/assistant-filters";
import { cn } from "@/lib/utils/cn";
import { type ReactNode, useRef, useState } from "react";
import type { IssueFilter } from "../types";

export interface ToolbarOption {
  value: string;
  label: string;
}

/** One filter the popover sets, read from and written to one URL param. */
interface ToolbarField {
  param: string;
  title: string;
  value: string;
  options: ToolbarOption[];
}

interface IssuesToolbarProps {
  segments: SegmentOption<IssueFilter>[];
  segment: IssueFilter;
  onSegment: (v: IssueFilter) => void;
  query: string;
  onQuery: (v: string) => void;
  fields: ToolbarField[];
  /** A filter set outside the popover (the assistant's explicit statuses), shown only as a chip. */
  extraChips: { param: string; label: string; value: string }[];
  onParam: (param: string, value: string) => void;
  onClear?: () => void;
  trailing?: ReactNode;
}

const ASSISTANT_CHIP = {
  borderColor: "var(--orange-500, #f97316)",
  color: "var(--orange-700, #c2410c)",
  background: "var(--orange-50, #fff7ed)",
};

// cm:why one row (owner, 2026-10-02): status segment · search · Filter popover · the active filters as removable chips · Clear, with no stacked rows or wrappers above the flush table
export function IssuesToolbar({
  segments,
  segment,
  onSegment,
  query,
  onQuery,
  fields,
  extraChips,
  onParam,
  onClear,
  trailing,
}: IssuesToolbarProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const assistantSet = useAssistantSetFilter();
  const active = fields.filter((f) => f.value !== "");
  const chips = [
    ...extraChips,
    ...active.map((f) => ({
      param: f.param,
      value: f.value,
      label: `${f.title}: ${f.options.find((o) => o.value === f.value)?.label ?? f.value}`,
    })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 sm:px-6">
      <SegmentedControl options={segments} value={segment} onChange={onSegment} />
      <Input
        icon="search"
        placeholder="Search issues…"
        aria-label="Search issues"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        className="w-full sm:w-56"
      />
      <div ref={anchor} className="relative">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon="filter"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          Filter
          {active.length > 0 && <Badge tone="accent">{active.length}</Badge>}
        </Button>
        <Popover
          open={open}
          anchor={anchor}
          onDismiss={() => setOpen(false)}
          placement="bottom-start"
          gap={6}
          role="dialog"
          aria-label="Filter issues"
          className="w-72 overflow-y-auto rounded-lg border border-line bg-surface p-3 shadow-lg"
        >
          <div className="flex flex-col gap-3">
            {fields.map((f) => (
              <fieldset key={f.param} className="m-0 border-0 p-0">
                <legend className="fg-caption mb-1.5 font-semibold text-muted">{f.title}</legend>
                <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                  {f.options.map((o) => {
                    const on = o.value === f.value;
                    return (
                      <button
                        key={o.value || "any"}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onParam(f.param, o.value)}
                        className={cn(
                          "rounded-pill border px-2 py-0.5 text-12-5 font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
                          on ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
                        )}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        </Popover>
      </div>
      {chips.map((c) => (
        <span
          key={c.param}
          data-testid="issues-filter-chip"
          className="inline-flex items-center gap-1 rounded-pill border border-line bg-sunken px-2 py-0.5 text-12-5 font-semibold text-fg"
          style={assistantSet(c.param, c.value) ? ASSISTANT_CHIP : undefined}
        >
          {c.label}
          <button
            type="button"
            aria-label={`Remove ${c.label}`}
            onClick={() => onParam(c.param, "")}
            className="leading-none"
          >
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      {onClear && (
        <button type="button" onClick={onClear} className="fg-body-sm font-semibold text-link hover:underline">
          Clear
        </button>
      )}
      {trailing ? <div className="ml-auto">{trailing}</div> : null}
    </div>
  );
}
