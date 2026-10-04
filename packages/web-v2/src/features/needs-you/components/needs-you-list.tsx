"use client";

// The rows the one needs-you read model answers (`GET /api/projects/:id/needs-you`), drawn as the
// shared grouped list, one group per area; nothing here decides what waits on the viewer.

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { GroupedList, type ListGroup, type ListRowView, useGroupFold, WaitingOn } from "@/design";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { needsYouHref, needsYouPeekHref } from "../routes";
import { NEEDS_YOU_AREA_LABELS, NEEDS_YOU_AREAS, type NeedsYouItem } from "../types";

const rowView =
  (slug: string) =>
  (n: NeedsYouItem): ListRowView => ({
    key: `${n.entity}:${n.key}`,
    keyLabel: n.entity === "schedule" || n.entity === "report" ? NEEDS_YOU_AREA_LABELS[n.area] : n.key,
    href: needsYouHref(slug, n),
    title: n.title,
    facts: [NEEDS_YOU_AREA_LABELS[n.area]],
    state: null,
    waitingOn: <WaitingOn w={n.waitingOn} />,
    owner: null,
    age: n.touchedAt ? { text: formatAge(n.touchedAt), title: `Last activity ${formatStamp(n.touchedAt)}` } : null,
  });

export function NeedsYouList({ items, slug, foldKey, empty }: { items: NeedsYouItem[]; slug: string; foldKey: string; empty: string }) {
  const router = useRouter();
  const fold = useGroupFold(foldKey);
  const row = useMemo(() => rowView(slug), [slug]);
  const groups: ListGroup<NeedsYouItem>[] = useMemo(
    () =>
      NEEDS_YOU_AREAS.map((area) => ({
        id: area,
        label: NEEDS_YOU_AREA_LABELS[area],
        tone: "you" as const,
        rows: items.filter((n) => n.area === area),
      })).filter((g) => g.rows.length > 0),
    [items],
  );
  const open = (key: string) => {
    const n = items.find((r) => `${r.entity}:${r.key}` === key);
    if (n) router.push(needsYouPeekHref(slug, n));
  };
  return <GroupedList ariaLabel="Needs you" groups={groups} fold={fold} row={row} selected={null} onPeek={open} empty={empty} />;
}
