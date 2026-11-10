// Needs you on the home itself, never only in a drawer (REQ-43 BC-17): the decisions waiting on the
// reader, the first few named and the rest one row to Approvals, or one "Nothing" row once read and
// none waits (ISS-1179). Its count is the read's `total`, the one Needs you number (REQ-48 BC-11).

import type { HomeNeedsYou } from "@forge/contracts/project-home";
import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { decisionLineOf } from "@forge/contracts/plain-decision";
import { GroupedList, type ListGroup, type ListRowView, StatusChip, useGroupFold } from "@/design";
import { decisionHref } from "@/features/needs-you";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import { approvalsHref, questionDecisionHref } from "@/lib/routes/approvals";

type Row = { kind: "decision"; d: NeedsYouDecision } | { kind: "more"; n: number } | { kind: "none" };

const keyOf = (row: Row) => (row.kind === "decision" ? `d:${row.d.id}` : row.kind);

function decisionPlace(slug: string, d: NeedsYouDecision): string {
  if (d.entity === "question") return questionDecisionHref(slug, d.key);
  return decisionHref(slug, d.opens) ?? approvalsHref(slug);
}

const quiet = (key: string, href: string, title: ListRowView["title"]): ListRowView => ({ key, href, title, facts: [], state: null, waitingOn: null, owner: null, age: null });

export function NeedsYouRows({ slug, needsYou }: { slug: string; needsYou: HomeNeedsYou }) {
  const t = useCopy();
  const time = useTimeFormat();
  const router = useRouter();
  const fold = useGroupFold("web-v2:home-needs-fold");
  const named: Row[] = needsYou.decisions.map((d) => ({ kind: "decision", d }));
  const more = needsYou.total - named.length;
  const rows: Row[] = needsYou.total === 0 ? [{ kind: "none" }] : more > 0 ? [...named, { kind: "more", n: more }] : named;
  const view = (row: Row): ListRowView => {
    if (row.kind === "none") return quiet("none", approvalsHref(slug), <span className="text-muted" data-testid="dashboard-needs-none">{t("dash.needs.none")}</span>);
    if (row.kind === "more") return quiet("more", approvalsHref(slug), <span className="text-muted">{t("dash.more", { n: row.n })}</span>);
    const d = row.d;
    const title = d.title || decisionLineOf(d).line;
    return {
      key: keyOf(row),
      href: decisionPlace(slug, d),
      title: <span title={title}>{title}</span>,
      facts: [],
      state: <StatusChip tone="you" label={t(`dash.decision.${d.group}`)} />,
      waitingOn: null,
      owner: null,
      age: d.touchedAt ? { text: time.age(d.touchedAt), title: time.dateTime(d.touchedAt) } : null,
    };
  };
  const groups: ListGroup<Row>[] = [{ id: "needs", label: t("dash.group.needs"), tone: "you", rows, total: needsYou.total }];
  const hrefs = new Map(rows.map((r) => [keyOf(r), view(r).href]));
  return (
    <GroupedList
      ariaLabel={t("dash.group.needs")}
      groups={groups}
      fold={fold}
      row={view}
      selected={null}
      onPeek={(key) => {
        const href = hrefs.get(key);
        if (href) router.push(href);
      }}
      keyColumn={false}
      empty={t("dash.needs.none")}
    />
  );
}
