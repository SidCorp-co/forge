// The master's passes as masters/passes serves them, newest first (ISS-903 face): one line each, when it
// started, its verb and what it moved in a few words ("1 dispatched · 1 skipped", "Refused"); a line
// opens in place (j/k, Enter) on what it dispatched, skipped with the refusal and parked, or the account's
// own words where it was refused and the recovery that followed (ISS-276, ISS-279: on the row once
// opened, never only in a hover title).
import { EnumBadge, ErrorState, ExpandRow, ExpandRows, Fact, FactsEmpty, ProjectLoader, StatusChip } from "@/design";
import { enumLabel } from "@/design/vocabulary";
import { formatApiError } from "@/lib/api/error";
import { formatWhen } from "@/lib/i18n/format";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { issueHref } from "@/lib/routes/issues";
import { useMasterPasses } from "../hooks";
import type { MasterClosedPass, MasterPassView } from "../types";
import { recoveryText } from "../view";

const closed = (p: MasterPassView): MasterClosedPass | null => ("endedAt" in p ? p : null);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const keyLink = (slug: string, k: string) =>
  /^[A-Z]+-\d+$/.test(k) ? (
    <Link href={issueHref(slug, k)} className="font-mono text-13 font-semibold text-link hover:underline">
      {k}
    </Link>
  ) : (
    <span>{k}</span>
  );

const keyList = (slug: string, keys: readonly string[]) =>
  keys.length === 0 ? (
    "—"
  ) : (
    <span className="inline-flex flex-wrap gap-x-2">
      {keys.map((k) => (
        <span key={k}>{keyLink(slug, k)}</span>
      ))}
    </span>
  );

/** What a pass moved, in a few words: refused, else its counts, else nothing. */
function PassSummary({ p }: { p: MasterPassView }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const c = closed(p);
  if (!c) return <span className="text-12 font-semibold text-link">{t("agents.master.now")}</span>;
  if (c.refused) return <StatusChip tone="err" label={t("agents.master.sum.refused")} reason={enumLabel("masterPassRefusal", c.refused.reason, language)} />;
  const parts = [
    c.dispatched.length ? t("agents.master.sum.dispatched", { n: c.dispatched.length }) : null,
    c.skipped.length ? t("agents.master.sum.skipped", { n: c.skipped.length }) : null,
    c.parked.length ? t("agents.master.sum.parked", { n: c.parked.length }) : null,
  ].filter(Boolean);
  return (
    <span className="min-w-0 truncate text-13 text-muted">
      {parts.length ? parts.join(" · ") : t("agents.master.sum.none")}
      {c.recovers ? <span className="ml-1.5 text-12 font-semibold text-link">{t("agents.master.recovered")}</span> : null}
    </span>
  );
}

function PassLine({ p }: { p: MasterPassView }) {
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <span className="w-28 flex-none text-13 text-muted" title={time.dateTime(p.startedAt)}>
        {formatWhen(p.startedAt, language)}
      </span>
      <EnumBadge family="masterVerb" value={p.verb} />
      <PassSummary p={p} />
    </span>
  );
}

/** What a pass opens on: the issue it is on, what it dispatched, skipped and parked, or why it was refused. */
function PassDetail({ p, slug }: { p: MasterPassView; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const c = closed(p);
  return (
    <div className="grid gap-1 pb-2" data-testid="master-pass-detail">
      {p.trigger === "unprompted" ? <p className="text-13 text-muted">{capitalize(t("agents.master.unprompted"))}</p> : null}
      {c?.recovers ? <p className="text-13 text-muted">{capitalize(recoveryText(c.recovers, language))}</p> : null}
      {c?.refused ? (
        <div className="grid gap-0.5 text-13 text-muted">
          <span>{t("agents.master.refusedBefore", { why: enumLabel("masterPassRefusal", c.refused.reason, language).toLowerCase() })}</span>
          <span className="break-words text-12">{t("agents.master.accountSaid", { said: c.refused.detail })}</span>
        </div>
      ) : null}
      {!c && p.issueKey ? <Fact label={t("agents.master.col.dispatched")}>{keyLink(slug, p.issueKey)}</Fact> : null}
      {c && !c.refused ? (
        <>
          <Fact label={t("agents.master.col.dispatched")}>{keyList(slug, c.dispatched)}</Fact>
          <Fact label={t("agents.master.col.skipped")}>
            {c.skipped.length === 0 ? (
              "—"
            ) : (
              <ul className="grid gap-0.5">
                {c.skipped.map((s) => (
                  <li key={s.issueKey}>
                    {keyLink(slug, s.issueKey)} <span className="text-13 text-muted">{s.refusal}</span>
                  </li>
                ))}
              </ul>
            )}
          </Fact>
          <Fact label={t("agents.master.col.parked")}>{keyList(slug, c.parked)}</Fact>
        </>
      ) : null}
    </div>
  );
}

/** The passes, newest first, one line each, opened in place. */
export function PassesList({ items, hasMore, slug }: { items: readonly MasterPassView[]; hasMore: boolean; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <section>
      <ExpandRows label={t("agents.master.tab.passes")} testId="master-passes">
        {items.map((p) => (
          <ExpandRow key={p.id} id={p.id} head={<PassLine p={p} />} testId="master-pass">
            <PassDetail p={p} slug={slug} />
          </ExpandRow>
        ))}
      </ExpandRows>
      {hasMore ? <p className="pt-2 text-12 text-subtle">{t("agents.master.newestN", { n: time.number(items.length) })}</p> : null}
    </section>
  );
}

export function Passes({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = useMasterPasses(projectId);
  if (q.isLoading) return <ProjectLoader label={t("agents.master.loadingPasses")} />;
  if (q.isError || !q.data) return <ErrorState message={formatApiError(q.error)} onRetry={() => void q.refetch()} />;
  if (q.data.items.length === 0) return <FactsEmpty>{t("agents.master.noPasses")}</FactsEmpty>;
  return <PassesList items={q.data.items} hasMore={q.data.hasMore} slug={slug} />;
}
