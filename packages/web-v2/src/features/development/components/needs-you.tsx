"use client";

import { ISSUE_ATTENTION_LABELS } from "@forge/contracts/issue-standing";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { ActorChip, GroupedList, type ListGroup, type ListRowView, StatusBadge, useGroupFold, WaitingOn } from "@/design";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { needHref, needPeekHref } from "../routes";
import type { OverviewNeed, OverviewNeeds } from "../types";

function stateOf(n: OverviewNeed) {
  const s = n.state;
  if (s.family === "issue") return <StatusBadge family="issue" value={s.value} step={s.step} tone={s.tone} />;
  if (s.family === "release") return <StatusBadge family="release" value={s.value} />;
  return <StatusBadge family="classification" value={s.value} />;
}

export const needRowView =
  (slug: string) =>
  (n: OverviewNeed): ListRowView => ({
    key: n.key,
    href: needHref(slug, n),
    title: n.title,
    facts: n.facts,
    state: stateOf(n),
    waitingOn: <WaitingOn w={n.waitingOn} />,
    owner: n.owner ? <ActorChip name={n.owner.name ?? "Unknown"} kind={n.owner.kind} size={20} /> : null,
    age: n.touchedAt ? { text: formatAge(n.touchedAt), title: `Last activity ${formatStamp(n.touchedAt)}` } : null,
  });

export function NeedsYou({ needs, slug }: { needs: OverviewNeeds; slug: string }) {
  const router = useRouter();
  const fold = useGroupFold("web-v2:development-overview:fold");
  const row = useMemo(() => needRowView(slug), [slug]);
  const groups: ListGroup<OverviewNeed>[] = useMemo(
    () => [{ id: "needs_you", label: ISSUE_ATTENTION_LABELS.needs_you.label, tone: "you", hint: ISSUE_ATTENTION_LABELS.needs_you.hint, rows: needs.rows }],
    [needs.rows],
  );
  const open = (key: string) => {
    const n = needs.rows.find((r) => r.key === key);
    if (n) router.push(needPeekHref(slug, n));
  };
  return (
    <section id="needs-you" aria-label="Needs you" className="scroll-mt-4" data-testid="needs-you">
      <GroupedList
        ariaLabel="Needs you"
        groups={groups}
        fold={fold}
        row={row}
        selected={null}
        onPeek={open}
        empty="Nothing waits on you. A question, a draft to take on, a release to approve or a contract version to decide shows here."
      />
    </section>
  );
}
