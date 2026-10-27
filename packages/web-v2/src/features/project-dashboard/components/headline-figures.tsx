// The Dashboard's first row: one number per thing a BA or PM checks first, each a link to where it is
// listed. A cell with nothing to count says so with a dash, never an invented figure.

import { StatCell, StatRow } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

export interface HeadlineFiguresProps {
  needsYou: number | null;
  running: number | null;
  atRisk: number | null;
  feedback: { open: number; untriaged: number; href: string };
  next: { version: string; eta: string | null; href: string } | null;
  live: { version: string; at: string | null; href: string } | null;
}

export function HeadlineFigures({ needsYou, running, atRisk, feedback, next, live }: HeadlineFiguresProps) {
  const t = useCopy();
  const none = t("dash.fig.none");
  const count = (n: number | null) => (n === null ? none : n);
  return (
    <StatRow cells={6} cellMin={150} testId="headline-figures">
      <StatCell label={t("dash.needsYou")} value={count(needsYou)} tone={needsYou ? "you" : undefined} href="#needs-you" testId="fig-needs-you" />
      <StatCell label={t("dash.fig.running")} value={count(running)} tone={running ? "run" : undefined} href="#running" testId="fig-running" />
      <StatCell label={t("dash.fig.atRisk")} value={count(atRisk)} tone={atRisk ? "err" : undefined} href="#at-risk" testId="fig-at-risk" />
      <StatCell
        label={t("dash.fig.feedback")}
        value={feedback.open}
        hint={feedback.untriaged > 0 ? t("dash.fig.untriaged", { n: feedback.untriaged }) : undefined}
        href={feedback.href}
        testId="fig-feedback"
      />
      <StatCell label={t("dash.nextRelease")} value={next?.version ?? none} hint={next?.eta ?? undefined} href={next?.href} testId="fig-next-release" />
      <StatCell label={t("dash.fig.live")} value={live?.version ?? none} hint={live?.at ?? undefined} href={live?.href} testId="fig-live" />
    </StatRow>
  );
}
