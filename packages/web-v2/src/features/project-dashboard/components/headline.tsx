// The sentence the dashboard opens with, before any number. A quiet project says nothing needs
// anyone; a working one says what is live and what waits on a person, each count worded with what it
// counts; a degraded one puts a full-width band in place of the figures row, naming what is wrong and
// offering one way in. A read that has not arrived is named here, never counted.

import Link from "next/link";
import { Icon } from "@/design";
import { TONE_META } from "@/design/status";
import type { ProjectReading } from "../shape";

export function Headline({ reading }: { reading: ProjectReading }) {
  const unread = reading.unread.length > 0 && (
    <ul className="mt-2 flex flex-col gap-0.5" data-testid="headline-unread">
      {reading.unread.map((line) => (
        <li key={line} className="fg-body-sm text-muted" role={line.includes("could not") ? "alert" : "status"}>
          {line}
        </li>
      ))}
    </ul>
  );

  if (reading.band) {
    const t = TONE_META.failure;
    const { text, entry } = reading.band;
    return (
      <section
        aria-label="What is wrong"
        data-testid="degraded-band"
        className="border-y px-4 py-3"
        style={{ background: t.bg, borderColor: t.dot }}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <p className="flex items-start gap-2 font-semibold" style={{ color: t.fg, fontSize: "var(--text-16)" }}>
            <Icon name="alert" size={18} className="mt-0.5 flex-none" />
            <span data-testid="dashboard-headline">{text}</span>
          </p>
          {entry && (
            <Link
              href={entry.href}
              className="fg-body-sm inline-flex flex-none items-center gap-1 font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              style={{ color: t.fg }}
            >
              {entry.label}
              <Icon name="arrowRight" size={14} />
            </Link>
          )}
        </div>
        {unread}
      </section>
    );
  }

  return (
    <section aria-label="Status" className="py-1">
      <p
        role="status"
        data-testid="dashboard-headline"
        className="font-semibold text-fg"
        style={{ fontSize: "var(--text-22)", lineHeight: 1.25 }}
      >
        {reading.headline}
      </p>
      {reading.detail && <p className="fg-body-sm mt-1 text-muted">{reading.detail}</p>}
      {unread}
    </section>
  );
}
