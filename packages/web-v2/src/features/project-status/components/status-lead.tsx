// What the status report leads with (REQ-48 BC-8, BC-11): what is stuck and why, then what needs the
// viewer, at most three with the rest counted. Both are core's reads (`stuck`, `needsYou`); a report
// stored before they existed has neither, and shows neither.

import type { ProjectStatus } from "@forge/contracts/project-status";
import { Link } from "@/lib/navigation/router";
import { type EtaClock } from "@/features/forecast";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { ReportPart } from "./report-part";

const ROW = "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line-subtle py-2 text-13";
const LIST = "border-t border-line-subtle";
/** A row leads with its title as the link; the key is the link's tooltip, never text on the face (ISS-1072). */
const TITLE_LINK = "min-w-0 flex-1 text-fg hover:text-link hover:underline";

export function StuckPart({ s, clock }: { s: ProjectStatus; clock: EtaClock }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const stuck = s.stuck;
  if (!stuck) return null;
  return (
    <ReportPart title={t("status.stuck")} asOf={stuck.asOf} clock={clock} count={stuck.count} lead testId="status-stuck">
      {stuck.items.length === 0 ? (
        <p className="text-13 text-muted">{t("status.stuckNone")}</p>
      ) : (
        <ul className={LIST}>
          {stuck.items.map((i) => (
            <li key={`${i.kind}:${i.key}`} className={ROW} data-testid="status-stuck-row">
              <Link href={i.href} className={TITLE_LINK} title={i.key}>
                {i.title}
              </Link>
              <span className="w-full text-13 text-danger">{said(i.says.reason, language)}</span>
              {i.note ? <span className="w-full text-13 text-muted" data-testid="status-stuck-note">{i.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {stuck.count > stuck.items.length ? <p className="text-13 text-muted">{t("status.stuckMore", { n: stuck.count - stuck.items.length })}</p> : null}
    </ReportPart>
  );
}

export function NeedsYouPart({ s, clock }: { s: ProjectStatus; clock: EtaClock }) {
  const t = useCopy();
  const needs = s.needsYou;
  if (!needs) return null;
  return (
    <ReportPart title={t("status.needsYou")} asOf={needs.asOf} clock={clock} count={needs.decisions.length + needs.more} lead testId="status-needs-you">
      {needs.decisions.length === 0 ? (
        <p className="text-13 text-muted">{t("status.needsYouNone")}</p>
      ) : (
        <ul className={LIST}>
          {needs.decisions.map((d) => (
            <li key={`${d.group}:${d.key}`} className={ROW} data-testid="status-needs-you-row">
              {d.href ? (
                <Link href={d.href} className={TITLE_LINK} title={d.key}>
                  {d.question}
                </Link>
              ) : (
                <span className="min-w-0 flex-1" title={d.key}>
                  {d.question}
                </span>
              )}
              {d.recommended ? <span className="text-13 text-muted">{t("status.recommended", { answer: d.recommended })}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {needs.more > 0 ? (
        <Link href="/attention" className="text-13 text-link hover:underline" data-testid="status-needs-you-more">
          {t("needsYou.decisions.capMore", { n: needs.more })}
        </Link>
      ) : null}
    </ReportPart>
  );
}
