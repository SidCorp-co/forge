// The approval inbox (REQ-8, REQ-11): everything in one project waiting on the viewer's approve-type
// decision, from core's one approvals read, oldest first. A chip per kind narrows the list, kept in
// the URL; each row is decided in place or opened on its own page.

import { type ApprovalKind, APPROVAL_KINDS } from "@forge/contracts/approvals";
import { EmptyState, ErrorState, FilterChip, ListPage, LoadingState, RowList, useUrlChoice } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useApprovals } from "../hooks";
import type { ApprovalInbox as Inbox } from "../types";
import { ApprovalEntry } from "./approval-entry";

const FILTERS = ["all", ...APPROVAL_KINDS] as const;
type Filter = (typeof FILTERS)[number];

function KindChips({ read, on, onPick }: { read: Inbox; on: Filter; onPick: (f: Filter) => void }) {
  const t = useCopy();
  const present = APPROVAL_KINDS.filter((k) => read.items.some((i) => i.kind === k));
  const count = (k: ApprovalKind) => read.items.filter((i) => i.kind === k).length;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="approval-kinds">
      <FilterChip on={on === "all"} onToggle={() => onPick("all")} count={read.total} tone="you">
        {t("approvals.filter.all")}
      </FilterChip>
      {present.map((k) => (
        <FilterChip key={k} on={on === k} onToggle={() => onPick(on === k ? "all" : k)} count={count(k)} testId={`approval-kind-${k}`}>
          {t(`approvals.kind.${k}`)}
        </FilterChip>
      ))}
    </div>
  );
}

export function ApprovalInbox({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = useApprovals(projectId);
  const [filter, setFilter] = useUrlChoice("kind", FILTERS, "all");
  const read = q.data;
  const rows = read ? read.items.filter((i) => filter === "all" || i.kind === filter) : [];
  return (
    <ListPage
      testId="approval-inbox"
      title={t("approvals.title")}
      toolbar={read && read.total > 0 ? <KindChips read={read} on={filter} onPick={setFilter} /> : undefined}
    >
      {q.isError ? (
        <ErrorState title={t("approvals.loadFailed")} message={formatApiError(q.error)} onRetry={() => void q.refetch()} />
      ) : !read ? (
        <LoadingState label={t("approvals.loading")} rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState message={t("approvals.empty")} />
      ) : (
        <RowList label={t("approvals.title")} testId="approval-list">
          {rows.map((item) => (
            <ApprovalEntry key={item.id} item={item} slug={slug} />
          ))}
        </RowList>
      )}
      {read && read.total > read.items.length ? (
        <p className="px-3 py-2 text-12 text-subtle">{t("approvals.more", { shown: read.items.length, total: read.total })}</p>
      ) : null}
    </ListPage>
  );
}
