"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { enumLabel, Tooltip } from "@/design";
import { type BusBuilder, builderProgress, triggerRef, type StepStatus } from "../bus";

export function Group({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 content-start gap-1.5 border-line-subtle px-4 pb-4 pt-1 sm:border-r sm:pl-7 sm:pr-[22px] sm:last:border-r-0">
      <h3 className="flex items-center gap-2 pt-2 text-11 font-semibold uppercase tracking-[0.07em] text-subtle">
        {title}
        {aside ? <span className="ml-auto normal-case tracking-normal">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

export function Head({ children }: { children: ReactNode }) {
  return <div className="col-span-full flex min-w-0 flex-wrap items-center gap-2 px-4 pb-1 pt-3 sm:px-7">{children}</div>;
}

export const Caption = ({ children }: { children: ReactNode }) => <p className="fg-caption break-words">{children}</p>;

export const PageLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="text-12 font-semibold text-[var(--accent-text)] hover:underline">
    {children}
  </Link>
);

const STEP_ICON: Record<StepStatus, string> = {
  succeeded: "✓",
  skipped: "–",
  running: "•",
  failed: "✕",
  pending: "",
  superseded: "↷",
};

const STEP_STYLE: Record<StepStatus, { background: string; color: string }> = {
  succeeded: { background: "var(--green-50)", color: "var(--green-600)" },
  skipped: { background: "var(--bg-sunken)", color: "var(--fg-subtle)" },
  running: { background: "var(--accent)", color: "var(--fg-on-accent)" },
  failed: { background: "var(--red-50)", color: "var(--red-600)" },
  pending: { background: "var(--bg-sunken)", color: "var(--fg-subtle)" },
  superseded: { background: "var(--bg-sunken)", color: "var(--fg-subtle)" },
};

export function Steps({ builder }: { builder: BusBuilder }) {
  return (
    <ol className="grid gap-1.5">
      {builder.steps.map((s) => {
        const row = (
          <span className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-2 text-13">
            <span
              className={`grid h-[18px] w-[18px] place-items-center rounded-full text-10 font-bold ${s.status === "running" ? "forge-pulse" : ""}`}
              style={STEP_STYLE[s.status]}
            >
              {STEP_ICON[s.status]}
            </span>
            <span className={s.status === "running" ? "font-semibold" : s.status === "pending" ? "text-subtle" : ""}>
              {s.name}
            </span>
          </span>
        );
        return (
          <li key={s.name}>
            {s.detail ? (
              <Tooltip label={`${s.status} · ${s.detail}`} multiline>
                {row}
              </Tooltip>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function BuilderSummary({ builder }: { builder: BusBuilder }) {
  const prog = builderProgress(builder);
  return (
    <>
      <Steps builder={builder} />
      <Tooltip label={`Started ${new Date(builder.createdAt).toLocaleString()} · updated ${new Date(builder.updatedAt).toLocaleString()}`}>
        <span className="fg-caption">
          {prog.done}/{prog.total} steps · on {enumLabel("trigger", builder.trigger.kind).toLowerCase()} at <span className="font-mono">{triggerRef(builder.trigger)}</span>
          {builder.stepsStale ? " · steps stale for this source: supersede the run" : ""}
        </span>
      </Tooltip>
    </>
  );
}
