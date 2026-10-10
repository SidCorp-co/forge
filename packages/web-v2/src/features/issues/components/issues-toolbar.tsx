"use client";

import { Badge, Button, ChoiceChips, Icon, Input, ListToolbar, Popover, SegmentedControl, type SegmentOption } from "@/design";
import { useAssistantSetFilter } from "@/features/chat-dock";
import { useCopy } from "@/lib/i18n/interface-language";
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


// one row (owner, 2026-10-02): status segment · search · Filter popover · the active filters as removable chips · Clear, with no stacked rows or wrappers above the flush table
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
  const anchorRef = useRef<HTMLDivElement>(null);
  const assistantSet = useAssistantSetFilter();
  const t = useCopy();
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
    <ListToolbar testId="issues-table-toolbar">
      <SegmentedControl options={segments} value={segment} onChange={onSegment} />
      <Input
        icon="search"
        placeholder={t("issues.toolbar.search")}
        aria-label={t("issues.toolbar.searchLabel")}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        className="w-full sm:w-56"
      />
      <div ref={anchorRef} className="relative">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon="filter"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {t("issues.toolbar.filter")}
          {active.length > 0 && <Badge tone="accent">{active.length}</Badge>}
        </Button>
        <Popover
          open={open}
          anchor={anchorRef}
          onDismiss={() => setOpen(false)}
          placement="bottom-start"
          gap={6}
          role="dialog"
          aria-label={t("issues.toolbar.filterLabel")}
          className="w-72 overflow-y-auto rounded-md p-3"
        >
          <div className="flex flex-col gap-3">
            {fields.map((f) => (
              <fieldset key={f.param} className="m-0 border-0 p-0">
                <legend className="fg-caption mb-1.5 font-semibold text-muted">{f.title}</legend>
                <ChoiceChips
                  label={f.title}
                  options={f.options.map((o) => ({ value: o.value, label: o.label }))}
                  value={[f.value]}
                  onChange={(next) => onParam(f.param, next[0] ?? "")}
                  className="max-h-32 overflow-y-auto"
                />
              </fieldset>
            ))}
          </div>
        </Popover>
      </div>
      {chips.map((c) => (
        <span
          key={c.param}
          data-testid="issues-filter-chip"
          // a filter the assistant set reads as the agent's
          className={cn(
            "inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-13 font-semibold",
            assistantSet(c.param, c.value) ? "border-ai-9 bg-ai-bg text-ai" : "border-line bg-sunken text-fg",
          )}
        >
          {c.label}
          <button
            type="button"
            aria-label={t("issues.toolbar.removeChip", { label: c.label })}
            onClick={() => onParam(c.param, "")}
            className="leading-none"
          >
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      {onClear && (
        <button type="button" onClick={onClear} className="fg-body-sm font-semibold text-link hover:underline">
          {t("issues.toolbar.clear")}
        </button>
      )}
      {trailing ? <div className="ml-auto">{trailing}</div> : null}
    </ListToolbar>
  );
}
