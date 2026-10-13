
// The settings page's blocks: groups headed in type, each holding labelled controls. A control's
// label sits above it (beside it with `inline`, for a toggle), a hint under it, and a refusal core
// named at it in the hint's place. A group's summary is one line of state, never an explanation. No
// card around a group: a hairline and whitespace part them.

import type { ReactNode } from "react";

export function SettingsGroup({ id, title, summary, right, children, testId }: { id?: string; title: ReactNode; summary?: ReactNode; right?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section id={id} aria-label={typeof title === "string" ? title : undefined} className="scroll-mt-24 border-t border-line py-6 first:border-t-0 first:pt-0" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="fg-h3 text-accent-text!">{title}</h3>
        {right ? <div className="ml-auto flex items-center gap-2">{right}</div> : null}
      </div>
      {summary ? <p className="fg-body-sm mt-1 max-w-prose text-muted">{summary}</p> : null}
      <div className="mt-4 space-y-5">{children}</div>
    </section>
  );
}

export function SettingRow({ label, hint, error, control, htmlFor, inline, testId }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; control: ReactNode; htmlFor?: string; inline?: boolean; testId?: string }) {
  return (
    <div className={inline ? "flex items-start justify-between gap-4" : "flex flex-col gap-1.5"} data-testid={testId}>
      <div className={inline ? "min-w-0 flex-1" : undefined}>
        <label htmlFor={htmlFor} className="fg-label text-fg">
          {label}
        </label>
        {inline && hint && !error ? <p className="fg-caption mt-0.5 text-muted">{hint}</p> : null}
      </div>
      {control}
      {!inline && hint && !error ? <p className="fg-caption text-muted">{hint}</p> : null}
      {error ? (
        <p role="alert" className="fg-caption text-danger-11">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The one save bar a form has, under its last group. */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 border-t border-line-subtle pt-4">{children}</div>;
}
