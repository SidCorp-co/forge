// The peek (`?peek=ISS-12`) beside the list: the row's head, whose turn it is, and then what the
// issue says — its description, its criteria with their marks, the newest comment — before the facts,
// so a reader learns what the issue is without the full page. The reads are the full page's own, by
// the same keys, so opening the page from here finds them answered.

import type { Forecast } from "@forge/contracts/forecast";
import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { BodyView, FactsGroup, PeekExcerpt, PeekHead, PeekPanel, type FullPage, type PeekState } from "@/design";
import type { EtaClock } from "@/features/forecast";
import { useCopy } from "@/lib/i18n/interface-language";
import { useComments, useIssue } from "../detail-hooks";
import type { CommentNode } from "../types";
import { CommentItem } from "./comment-thread";
import { CriteriaList } from "./criteria-list";
import { IssueBanner, IssuePeekProperties, IssueStrip, issueBadge } from "./issue-standing-bits";
import { Written } from "@/lib/i18n/written";

/** The newest comment anywhere in the thread, replies included, drawn without the replies under it. */
export function newestComment(nodes: readonly CommentNode[]): CommentNode | null {
  let newest: CommentNode | null = null;
  const visit = (node: CommentNode) => {
    if (!newest || node.createdAt > newest.createdAt) newest = node;
    node.replies.forEach(visit);
  };
  nodes.forEach(visit);
  return newest ? { ...(newest as CommentNode), replies: [] } : null;
}

export function IssuePeek({
  projectId,
  slug,
  row,
  forecast,
  clock,
  peek,
  full,
}: {
  projectId: string;
  slug: string;
  row: IssueStandingRow;
  forecast?: Forecast | undefined;
  clock: EtaClock;
  peek: PeekState;
  full: FullPage;
}) {
  const t = useCopy();
  const issue = useIssue(row.key, projectId).data;
  const comments = useComments(issue?.id, projectId).data;
  const latest = newestComment(comments?.items ?? []);
  return (
    <PeekPanel peek={peek} listLabel={t("issues.screen.title")} noun={t("issues.noun")} full={full} testId="issue-peek">
      <PeekHead noun={t("issues.noun")} itemKey={row.key} badge={issueBadge(row)} title={<Written text={row.title} lang={row.writtenLang} />} />
      <div className="px-4.5 pb-3">
        <IssueStrip standing={row.standing} />
      </div>
      <IssueBanner standing={row.standing} className="mx-4.5 rounded-md" />
      <div className="px-4.5 pb-4 pt-4">
        {issue?.description ? (
          <FactsGroup title={t("issues.description.title")} testId="issue-peek-description">
            <PeekExcerpt>
              <div lang={issue.writtenLang ?? undefined}>
                <BodyView body={issue.description} format={issue.descriptionFormat} nodes={issue.descriptionNodes} />
              </div>
            </PeekExcerpt>
          </FactsGroup>
        ) : null}
        {issue ? (
          <section className="border-t border-line-subtle py-3.5 first:border-t-0 first:pt-0" data-testid="issue-peek-criteria">
            <CriteriaList issueId={issue.id} />
          </section>
        ) : null}
        {latest ? (
          <FactsGroup title={t("issues.peek.latestComment")} count={t("issues.peek.commentCount", { n: comments?.totalCount ?? 0 })} testId="issue-peek-comment">
            <PeekExcerpt>
              <CommentItem node={latest} issueId={latest.issueId} members={undefined} depth={0} readOnly />
            </PeekExcerpt>
          </FactsGroup>
        ) : null}
        <FactsGroup title={t("issues.rail.properties")} testId="issue-peek-facts-group">
          <IssuePeekProperties row={row} slug={slug} forecast={forecast} clock={clock} />
        </FactsGroup>
      </div>
    </PeekPanel>
  );
}
