// A release in the list's peek (REQ-40 BC-18): the same overview its page opens on, from the same read
// (`useReleasePage`, the user view), shortened — its name and status, its summary, its first changes
// whole with how many more the page holds, and one line on what it needs before it goes out.

import { releasePeekLines } from "@forge/contracts/release-digest";
import type { ReleasePage } from "@forge/contracts/release-page";
import { PeekHead, PeekPanel, type FullPage, type PeekState, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRelease, useReleasePage } from "../hooks";
import { releaseStandingOf } from "../release-standing";
import type { ReleaseDetail } from "../types";
import { ReleaseActions } from "./release-actions";
import { releaseTitle } from "./release-bits";
import { ChangeTag } from "./release-groups";

function PeekOverview({ r, page }: { r: ReleaseDetail; page: ReleasePage }) {
  const t = useCopy();
  const time = useTimeFormat();
  const { shown, more } = releasePeekLines(page);
  const steps = page.actionRequired.length;
  const next = releaseStandingOf(r, t, time.date).next;
  const action = [
    ...(steps > 0 ? [t(steps === 1 ? "releases.peek.steps.one" : "releases.peek.steps.many", { n: steps })] : []),
    ...(next ? [t("releases.peek.next", { step: next })] : []),
  ];
  return (
    <div className="grid gap-4 px-4.5 pb-4" data-testid="release-peek-overview">
      {page.header.summary ? (
        <p className="text-14 leading-relaxed text-fg" data-testid="release-peek-summary">
          {page.header.summary}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="grid divide-y divide-line-subtle border-y border-line-subtle" data-testid="release-peek-changes">
          {shown.map(({ group, change }) => (
            <li key={`${change.issueKey}:${change.line}`} className="flex items-baseline gap-2.5 py-2 text-13-5" data-testid="release-peek-change">
              <ChangeTag group={group} />
              <span className="min-w-0 flex-1 text-fg">{change.line}</span>
            </li>
          ))}
          {more > 0 ? (
            <li className="py-2 text-13 text-muted" data-testid="release-peek-more">
              {t("releases.peek.more", { n: more })}
            </li>
          ) : null}
        </ul>
      ) : null}
      {action.length > 0 ? (
        <p className="text-13 font-medium text-warn-11" data-testid="release-peek-action">
          {action.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

export function ReleasePeek({
  projectId,
  version,
  peek,
  full,
}: {
  projectId: string;
  version: string;
  peek: PeekState;
  full: FullPage;
}) {
  const t = useCopy();
  const q = useRelease(projectId, version);
  const pageQ = useReleasePage(projectId, version, "user");
  return (
    <PeekPanel peek={peek} listLabel={t("releases.title")} noun={t("releases.noun")} full={full} testId="release-peek">
      <QueryBoundary query={q} loadingLabel={t("releases.loadingOne")}>
        {(data) => {
          const r = data.release;
          return (
            <>
              <PeekHead
                noun={t("releases.noun")}
                itemKey={r.version}
                badge={<StatusBadge family="releaseState" value={r.state} />}
                title={<span data-testid="release-peek-title">{releaseTitle(r, t)}</span>}
                action={<ReleaseActions projectId={projectId} r={r} />}
              />
              <QueryBoundary query={pageQ} loadingLabel={t("releases.page.loading")}>
                {(page) => <PeekOverview r={r} page={page} />}
              </QueryBoundary>
            </>
          );
        }}
      </QueryBoundary>
    </PeekPanel>
  );
}
