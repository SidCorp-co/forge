// The Dashboard's first line: the figures a BA or PM checks that no section below already counts —
// open feedback, the next release and the last one shipped — label first, flush on one line, never a
// row of tiles (ISS-903). Needs you, Running and At risk are counted by their own sections' titles
// beneath, so they are not said twice. Each figure links to where it is listed; one with nothing to
// count says so with a dash, never an invented figure.

import type { ReactNode } from "react";
import { Signal } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";

export interface HeadlineFiguresProps {
  feedback: { open: number; untriaged: number; href: string };
  next: { version: string; eta: string | null; href: string } | null;
  live: { version: string; at: string | null; href: string } | null;
}

/** A figure's value, a link where it is listed; a muted aside after it. */
function Figure({ value, href, aside, mono = false }: { value: ReactNode; href?: string; aside?: string | null; mono?: boolean }) {
  const shown = <span className={mono ? "font-mono font-semibold" : "font-semibold"}>{value}</span>;
  return (
    <>
      {href ? (
        <Link href={href} className="hover:text-accent-text hover:underline">
          {shown}
        </Link>
      ) : (
        shown
      )}
      {aside ? <span className="text-muted">{aside}</span> : null}
    </>
  );
}

export function HeadlineFigures({ feedback, next, live }: HeadlineFiguresProps) {
  const t = useCopy();
  const none = t("dash.fig.none");
  return (
    <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2" aria-label={t("overview.signal.signals")} data-testid="headline-figures">
      <Signal label={t("dash.fig.feedback")} testId="fig-feedback">
        <Figure value={feedback.open} href={feedback.href} aside={feedback.untriaged > 0 ? t("dash.fig.untriaged", { n: feedback.untriaged }) : null} />
      </Signal>
      <Signal label={t("dash.nextRelease")} testId="fig-next-release">
        <Figure value={next?.version ?? none} href={next?.href} aside={next?.eta} mono={!!next} />
      </Signal>
      <Signal label={t("dash.fig.live")} testId="fig-live">
        <Figure value={live?.version ?? none} href={live?.href} aside={live?.at} mono={!!live} />
      </Signal>
    </dl>
  );
}
