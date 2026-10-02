"use client";

import { Fragment, useRef, useState } from "react";
import { Button, Icon, IconButton, Popover, Tooltip } from "@/design";
import { TONE_META } from "@/design/status";
import { cn } from "@/lib/utils/cn";
import { stampOf } from "../format";
import {
  type ReleaseFlow,
  type StepState,
  stageCounts,
  stepStates,
  stepTip,
} from "../flow";
import type { ReleaseProcedure, ReleaseVersionList, ReleaseVersionRow } from "../versions-types";

export const STEP_COLOR: Record<StepState, string> = {
  passed: TONE_META.success.dot,
  done: TONE_META.success.dot,
  current: TONE_META.active.dot,
  waiting: TONE_META.attention.dot,
  failed: TONE_META.failure.dot,
  aborted: TONE_META.neutral.dot,
  pending: "var(--bg-sunken)",
  untracked: "transparent",
  skipped: "transparent",
};

function ProcedureButton({ procedure }: { procedure: ReleaseProcedure }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={ref}
        icon="info"
        size="sm"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Release procedure"
        title="Release procedure"
        data-testid="release-procedure"
      />
      <Popover
        open={open}
        anchor={ref}
        onDismiss={() => setOpen(false)}
        placement="bottom-end"
        takesFocus
        role="dialog"
        aria-label="Release procedure"
        className="forge-drop w-[360px] overflow-y-auto rounded-lg border border-line bg-surface shadow-lg"
      >
        <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-4 py-2.5">
          <span className="text-13 font-semibold" title={`knowledge · ${procedure.slug} · ${stampOf(procedure.updatedAt)}`}>
            {procedure.title}
          </span>
          <IconButton icon="x" size="sm" type="button" onClick={() => setOpen(false)} aria-label="Close" />
        </div>
        <p className="whitespace-pre-wrap px-4 py-3 text-13 text-muted" data-testid="release-procedure-body">
          {procedure.body}
        </p>
      </Popover>
    </>
  );
}

export interface FlowStripProps {
  list: ReleaseVersionList;
  flow: ReleaseFlow;
  active: string | null;
  onPick: (key: string | null) => void;
}

/** The stages a version passes through on this project, each with how many versions stand in it. */
export function FlowStrip({ list, flow, active, onPick }: FlowStripProps) {
  const counts = stageCounts(list, flow);
  return (
    <nav className="flex items-center gap-1 overflow-x-auto px-4 pb-3 sm:px-7" aria-label="Release flow" data-testid="flow-strip">
      {flow.stages.map((s, i) => {
        const n = counts[s.key] ?? 0;
        const tip = s.kind === "draft" && list.draft ? `${s.tip} · ${list.draft.issues.length} issues` : s.tip;
        return (
          <Fragment key={s.key}>
            {i > 0 ? <Icon name="chevronRight" size={13} className="flex-none text-subtle" aria-hidden /> : null}
            <Tooltip label={tip} side="bottom" multiline>
              <Button
                type="button"
                size="sm"
                variant={active === s.key ? "primary" : "secondary"}
                aria-disabled={!s.tracked}
                aria-pressed={active === s.key}
                onClick={() => s.tracked && onPick(active === s.key ? null : s.key)}
                className={cn("flex-none gap-1.5 whitespace-nowrap text-12", !s.tracked && "cursor-default border-dashed text-muted")}
                data-testid="flow-stage"
                data-stage={s.key}
              >
                {s.locked ? <Icon name="lock" size={12} aria-label="required" /> : null}
                <span>{s.label}</span>
                {s.env ? <span className="font-mono text-11 font-normal opacity-75">{s.env.trigger}</span> : null}
                {s.tracked ? (
                  <span
                    className={cn("font-mono text-11", n > 0 && active !== s.key && s.kind === "approval" && "text-amber")}
                    data-testid="flow-count"
                  >
                    {n}
                  </span>
                ) : null}
              </Button>
            </Tooltip>
          </Fragment>
        );
      })}
      {list.procedure ? (
        <span className="ml-auto pl-2">
          <ProcedureButton procedure={list.procedure} />
        </span>
      ) : null}
    </nav>
  );
}

/** A version's place along the same stages: one segment each. */
export function StageTracker({ v, flow }: { v: ReleaseVersionRow; flow: ReleaseFlow }) {
  const states = stepStates(v, flow);
  return (
    <span
      className="flex items-center gap-0.5"
      role="img"
      aria-label={flow.stages.map((s, i) => `${s.label} ${states[i]}`).join(", ")}
      data-testid="stage-tracker"
    >
      {flow.stages.map((s, i) => {
        const st = states[i];
        return (
          <Tooltip key={s.key} label={stepTip(v, s, st, flow.deployKey)} multiline>
            <i
              className={cn(
                "block h-1.5 w-3.5 rounded-sm",
                (st === "untracked" || st === "skipped" || st === "pending") && "border border-line",
                st === "untracked" && "border-dashed",
                (st === "current" || st === "waiting" || st === "failed") && "ring-2 ring-offset-1 ring-offset-surface",
              )}
              style={{ background: STEP_COLOR[st], ["--tw-ring-color" as string]: STEP_COLOR[st] }}
              data-state={st}
              aria-hidden
            />
          </Tooltip>
        );
      })}
    </span>
  );
}
