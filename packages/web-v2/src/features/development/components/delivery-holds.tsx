import { useState } from "react";
import { SegmentedControl, WaitingOn } from "@/design";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { Link } from "@/lib/navigation/router";
import { issueHref } from "@/lib/routes/issues";
import type { OverviewHold, OverviewHoldGroup, OverviewHolds } from "../types";

type By = "issue" | "release";

function HoldEntry({ hold }: { hold: OverviewHold }) {
  const t = useCopy();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  return (
    <li
      className="flex gap-x-3 gap-y-1 py-2 max-md:flex-col"
      data-testid="delivery-hold"
      data-kind={hold.kind}
    >
      <span className="w-24 shrink-0 text-12 font-semibold text-muted">{t(`overview.hold.kind.${hold.kind}`)}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-13 text-fg" data-testid="hold-cause">
          {said(hold.says.cause, language)}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          <WaitingOn w={hold.waitingOn} />
          {hold.since ? <span className="text-12 text-subtle">{t("overview.hold.since", { age: time.age(hold.since) })}</span> : null}
        </div>
      </div>
    </li>
  );
}

function Group({ group, by, slug }: { group: OverviewHoldGroup; by: By; slug: string }) {
  const t = useCopy();
  return (
    <li className="border-b border-line-subtle py-2 last:border-b-0" data-testid="hold-group" data-key={group.key}>
      <div className="flex min-w-0 items-baseline gap-2">
        {by === "issue" ? (
          <Link href={issueHref(slug, group.key)} className="shrink-0 font-mono text-12 font-semibold text-link no-underline hover:underline">
            {group.key}
          </Link>
        ) : (
          <span className="shrink-0 font-mono text-12 font-semibold">{t("overview.hold.release", { version: group.key })}</span>
        )}
        {by === "issue" && group.title !== group.key ? <span className="truncate text-13 text-muted">{group.title}</span> : null}
      </div>
      <ul className="divide-y divide-line-subtle">
        {group.holds.map((h) => (
          <HoldEntry key={`${h.kind}:${h.runId ?? h.issues.join(",")}`} hold={h} />
        ))}
      </ul>
    </li>
  );
}

/** What holds delivery back, per issue or per release, each hold with its cause and who acts next (REQ-74 BC-4, BC-5). */
export function DeliveryHolds({ holds, slug }: { holds: OverviewHolds; slug: string }) {
  const t = useCopy();
  const [by, setBy] = useState<By>("issue");
  if (holds.count === 0) return <p className="text-13 text-muted">{t("overview.hold.empty")}</p>;
  const groups = by === "issue" ? holds.issues : holds.releases;
  return (
    <div data-testid="delivery-holds">
      <div className="pb-2">
        <SegmentedControl<By>
          value={by}
          onChange={setBy}
          options={[
            { value: "issue", label: t("overview.hold.byIssue"), count: holds.issues.length },
            { value: "release", label: t("overview.hold.byRelease"), count: holds.releases.length },
          ]}
        />
      </div>
      {groups.length === 0 ? (
        <p className="text-13 text-muted">{t("overview.hold.noRelease")}</p>
      ) : (
        <ul aria-label={t("overview.hold.title")}>
          {groups.map((g) => (
            <Group key={g.key} group={g} by={by} slug={slug} />
          ))}
        </ul>
      )}
    </div>
  );
}
