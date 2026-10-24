// A business criterion's verdicts recorded at the requirement itself (ISS-588): the evidence of a
// capability that already shipped, listed beside the issue rows in the criterion's Evidence.

import type { CoverageRequirementVerdict } from "@forge/contracts/requirements";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { VERDICT_WORD } from "./standing-bits";

/** A cited link opens; a repository path at the judged commit reads as text. */
const isLink = (e: string) => /^https?:\/\//iu.test(e);

export function OwnVerdictRows({ verdicts, developer }: { verdicts: readonly CoverageRequirementVerdict[]; developer: boolean }) {
  const t = useCopy();
  const time = useTimeFormat();
  return verdicts.map((v) => (
    <li key={v.verdictId} className="text-muted" data-testid="criterion-own-verdict">
      <span className="font-medium text-fg">{t(VERDICT_WORD[v.verdict])}</span>
      <span title={time.dateTime(v.verdictAt)}> · {time.relative(v.verdictAt)}</span>
      {developer && v.identity ? <span className="font-mono text-12"> · {v.identity}</span> : null}
      {v.stale ? t("requirements.criteria.tracesEarlier") : ""}
      {v.notCounted ? t("requirements.criteria.notCounted", { reason: v.notCounted }) : ""}
      {developer && v.note ? <p className="mt-0.5 whitespace-pre-wrap pl-3">{v.note}</p> : null}
      {v.evidence.length > 0 ? (
        <ul className="mt-0.5 grid gap-0.5 pl-3">
          {v.evidence.map((e) => (
            <li key={e} className="truncate text-12">
              {isLink(e) ? (
                <a href={e} className="text-link hover:underline" target="_blank" rel="noreferrer">
                  {e}
                </a>
              ) : (
                <span className="font-mono">{e}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  ));
}
