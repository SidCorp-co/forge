// The home's search (ISS-919): any issue or feedback item by key or a title word, answered with
// where it stands, from core's `GET /api/me/home/find`.

import { ListSearch, useDebounced } from "@/design";
import { useActiveOrg } from "@/features/orgs";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { useState } from "react";
import { itemHref } from "../home-rows";
import { HOME_FIND_MIN, useHomeFind } from "../hooks";
import type { HomeFoundItem } from "../types";

export function ItemFinder() {
  const t = useCopy();
  const [text, setText] = useState("");
  const q = useDebounced(text, 300);
  const { activeOrgId } = useActiveOrg();
  const found = useHomeFind(q, activeOrgId);
  const asked = q.trim().length >= HOME_FIND_MIN;
  return (
    <div className="flex flex-col gap-2" data-testid="home-find">
      <ListSearch noun={t("overview.home.find.noun")} value={text} onChange={setText} />
      {asked && found.data ? (
        found.data.items.length === 0 ? (
          <p className="fg-body-sm text-muted">{t("overview.home.find.none")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-subtle border-y border-line-subtle" aria-live="polite">
            {found.data.items.map((f) => (
              <FoundItem key={`${f.projectSlug}:${f.key}`} item={f} />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

function FoundItem({ item }: { item: HomeFoundItem }) {
  const t = useCopy();
  const time = useTimeFormat();
  const s = item.standing;
  const says =
    s.kind === "live"
      ? t(`overview.home.find.live.${s.environment}`, { since: time.date(s.since), version: s.version })
      : s.kind === "moving"
        ? t(`overview.home.stage.${s.stage}`)
        : t(`overview.home.find.ended.${s.how}`);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2" data-testid="home-found">
      <Link href={itemHref(item)} title={item.key} className="min-w-0 fg-body-sm hover:underline">
        {item.title}
      </Link>
      <span className="text-12 text-muted" data-testid="home-found-says">
        {[says, item.projectName].join(" · ")}
      </span>
    </li>
  );
}
