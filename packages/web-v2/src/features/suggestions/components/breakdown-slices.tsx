import { statusReading } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { SuggestionBreakdownBlocker, SuggestionBreakdownRead, SuggestionBreakdownSlice } from "../types";

/** What a slice waits on, in the words its accept would write the edge with, or the refusal it would give. */
function blockerLine(b: SuggestionBreakdownBlocker, t: Copy, language: string, at: { n: number; count: number }): { text: string; refused?: string } {
  if ("slice" in b) return { text: t("requirements.suggestion.afterSlice", { n: b.slice + 1, title: b.title }) };
  if ("issue" in b) return { text: t("requirements.suggestion.afterIssue", { issue: b.issue, title: b.title, status: statusReading("issue", b.status, language).label }) };
  if (/^\d+$/.test(b.ref)) return { text: sliceRefusal(Number(b.ref) + 1, at, t), refused: b.code };
  return { text: t("requirements.suggestion.wouldRefuse", { ref: b.ref, refusal: b.refusal }), refused: b.code };
}

/**
 * A refused wait on another slice, by its 0-based index in the payload, worded with the slice numbers
 * the list shows (the first is slice 1): Accept refuses a slice naming itself, a slice outside the
 * breakdown, and the edge that closes a loop (`suggestions/rules.ts:blockerFaults`), and nothing else
 * among the breakdown's own slices.
 */
function sliceRefusal(slice: number, at: { n: number; count: number }, t: Copy): string {
  if (slice === at.n) return t("requirements.suggestion.wouldRefuseSelf");
  if (slice > at.count) return t("requirements.suggestion.wouldRefuseOutside", { n: slice, count: at.count });
  return t("requirements.suggestion.wouldRefuseCycle", { n: slice });
}

function buildsLine(s: SuggestionBreakdownSlice, t: Copy): string {
  if (s.buildsRefusal) return t("requirements.suggestion.wouldRefuseDesign", { refusal: s.buildsRefusal });
  if (!s.builds) return t("requirements.suggestion.buildsNone");
  return s.builds.designRevision === null
    ? t("requirements.suggestion.builds", { flow: s.builds.flow })
    : t("requirements.suggestion.buildsR", { flow: s.builds.flow, r: s.builds.designRevision });
}

function Slice({ s, n, count }: { s: SuggestionBreakdownSlice; n: number; count: number }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (
    <li className="grid gap-0.5" data-testid="breakdown-slice">
      <p className="text-fg">
        <span className="font-semibold">
          {n}. {s.title}
        </span>{" "}
        <span className="text-subtle">{t("requirements.suggestion.complexity", { c: s.complexity })}</span>
      </p>
      <p className="whitespace-pre-wrap">{s.description ?? t("requirements.suggestion.noDescription")}</p>
      <ul className="grid gap-0.5 pl-3">
        {s.criteria.map((c) => (
          <li key={`${c.code} · ${c.body}`}>{`${c.code} · ${c.body}`}</li>
        ))}
      </ul>
      <p className={s.buildsRefusal ? "text-danger" : undefined}>{buildsLine(s, t)}</p>
      {s.blockedBy.map((b) => {
        const line = blockerLine(b, t, language, { n, count });
        return (
          <p key={line.text} className={line.refused ? "text-danger" : undefined} title={line.refused}>
            {line.text}
          </p>
        );
      })}
    </li>
  );
}

/** Each slice with the number its blockers name it by, `slice n`. */
const numbered = (slices: SuggestionBreakdownSlice[]) => slices.map((s, i) => ({ s, n: i + 1 }));

/**
 * A proposed breakdown's slices as core reads them for its accept (ISS-278): each slice's description,
 * criteria by BC code, the design revision it builds and what it waits on, so it is judged before its
 * issues exist. A breakdown that no longer reads says so in words, its code and path beside them.
 */
export function BreakdownSlices({ read }: { read: SuggestionBreakdownRead | undefined }) {
  const t = useCopy();
  if (!read) return <p data-testid="breakdown-slices">{t("requirements.suggestion.noReading")}</p>;
  if (read.unreadable) {
    return (
      <div data-testid="breakdown-slices" className="mt-1 grid gap-0.5">
        <p className="text-danger">{t("requirements.suggestion.unreadable")}</p>
        <p className="font-mono text-11-5 text-subtle">{read.unreadable}</p>
      </div>
    );
  }
  return (
    <div className="mt-1 grid gap-2" data-testid="breakdown-slices">
      <ol className="grid gap-2">
        {numbered(read.slices).map(({ s, n }) => (
          <Slice key={`${n}. ${s.title}`} s={s} n={n} count={read.slices.length} />
        ))}
      </ol>
      {read.uncovered.length > 0 ? (
        <p>{t("requirements.suggestion.uncovered", { list: read.uncovered.map((u) => `${u.code} · ${u.reason}`).join("; ") })}</p>
      ) : null}
    </div>
  );
}
