"use client";

// Workspace-tier Activity feed (`/activity`) — migrates v1's Chat Logs index
// into web-v2 as a cross-project stream of agent Q&A turns.
//
// Usage/cost decision (ISS-314 AC2): v1's Usage dashboard (`/usage`) is built
// entirely on `GET /api/usage-records/summary`, which REQUIRES a `projectId` —
// it is inherently a per-project surface (daily cost line, model/source cost
// breakdown). There is no cross-project usage-rollup endpoint, so reproducing
// those charts here would mean fanning out N per-project calls and client-side
// merging — wrong altitude for a workspace feed. Instead we represent usage as
// *throughput* derived from the chat-log rows themselves (conversation count +
// input/output token totals). The full per-project cost dashboard stays a
// project-scoped concern (project detail / ops), not the cross-project feed.
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Markdown,
  MonoTag,
  Select,
  SegmentedControl,
  Skeleton,
  SlideOver,
  Stat,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  type SegmentOption,
  type SelectOption,
} from "@/design";
import { formatRelativeTime } from "@/features/projects/derive";
import { formatApiError } from "@/lib/api/error";
import { ACTIVITY_PAGE_SIZE } from "../api";
import { useActivity } from "../hooks";
import {
  formatDuration,
  formatTokens,
  ratingTone,
  sumTokens,
  type ChatLogRow,
  type QaRating,
  type SourceFilter,
} from "../types";

const SOURCE_OPTIONS: SegmentOption<SourceFilter>[] = [
  { value: "", label: "All" },
  { value: "web", label: "Web" },
  { value: "cli", label: "CLI" },
  { value: "mcp", label: "MCP" },
  { value: "api", label: "API" },
];

const INTENT_OPTIONS: SelectOption[] = [
  { value: "", label: "All intents" },
  { value: "SEARCH", label: "Search" },
  { value: "LOOKUP", label: "Lookup" },
  { value: "CREATE", label: "Create" },
  { value: "SUMMARY", label: "Summary" },
  { value: "ACTION", label: "Action" },
  { value: "CHAT", label: "Chat" },
];

const RATING_OPTIONS: SelectOption[] = [
  { value: "", label: "All ratings" },
  { value: "good", label: "Good" },
  { value: "bad", label: "Bad" },
  { value: "flagged", label: "Flagged" },
];

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="py-3.5">
        <p className="fg-overline">{label}</p>
        <p className="mt-1 font-mono text-xl font-semibold text-fg">{value}</p>
        {hint && <p className="fg-body-sm mt-0.5 text-subtle">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function RatingChip({ rating }: { rating: QaRating }) {
  return (
    <Badge tone={ratingTone(rating)}>{rating}</Badge>
  );
}

export function ActivityScreen() {
  const [source, setSource] = useState<SourceFilter>("");
  const [intent, setIntent] = useState("");
  const [qaRating, setQaRating] = useState<QaRating | "">("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ChatLogRow | null>(null);

  const activityQ = useActivity({ source, intent, qaRating, page });

  const rows = useMemo(() => activityQ.data?.items ?? [], [activityQ.data]);
  const totalCount = activityQ.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / ACTIVITY_PAGE_SIZE));
  const tokens = useMemo(() => sumTokens(rows), [rows]);
  const now = Date.now();

  // Any filter change resets to page 1 so the user never lands on an empty
  // out-of-range page.
  function changeFilter<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setPage(1);
    };
  }

  const hasFilters = source !== "" || intent !== "" || qaRating !== "";

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="fg-h2">Activity</h1>
          <p className="fg-body-sm mt-1 text-muted">
            Agent conversations across every project you can see.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon="rerun"
          loading={activityQ.isFetching}
          onClick={() => activityQ.refetch()}
        >
          Refresh
        </Button>
      </header>

      {/* Throughput — derived from the feed (see usage/cost decision above). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatCard label="Conversations" value={totalCount.toLocaleString()} hint="matching filters" />
        <StatCard label="Input tokens" value={formatTokens(tokens.input)} hint="this page" />
        <StatCard label="Output tokens" value={formatTokens(tokens.output)} hint="this page" />
      </div>

      {/* Filters */}
      <div className="mt-6 mb-4 flex flex-wrap items-center gap-3">
        <div className="overflow-x-auto">
          <SegmentedControl options={SOURCE_OPTIONS} value={source} onChange={changeFilter(setSource)} />
        </div>
        <div className="w-40">
          <Select options={INTENT_OPTIONS} value={intent} onChange={changeFilter(setIntent)} />
        </div>
        <div className="w-40">
          <Select
            options={RATING_OPTIONS}
            value={qaRating}
            onChange={changeFilter((v: string) => setQaRating(v as QaRating | ""))}
          />
        </div>
      </div>

      {/* LOADING */}
      {activityQ.isLoading && (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-line-subtle px-4 py-3 last:border-0"
            >
              <Skeleton className="h-4 w-20" />
              <Skeleton variant="text" className="w-1/3" />
              <Skeleton className="ml-auto h-5 w-16 rounded-pill" />
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      )}

      {/* ERROR */}
      {activityQ.isError && (
        <ErrorState
          title="Couldn't load activity"
          message={formatApiError(activityQ.error)}
          onRetry={() => activityQ.refetch()}
        />
      )}

      {/* EMPTY */}
      {!activityQ.isLoading && !activityQ.isError && rows.length === 0 && (
        <EmptyState
          title={hasFilters ? "Nothing matches" : "No activity yet"}
          message={
            hasFilters
              ? "No conversations match these filters. Try widening them."
              : "Agent conversations across your projects will appear here as they happen."
          }
          mascot={!hasFilters}
        />
      )}

      {/* CONTENT */}
      {!activityQ.isLoading && !activityQ.isError && rows.length > 0 && (
        <>
          {/* Desktop / tablet: dense table. */}
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR>
                  <TH>Project</TH>
                  <TH>Query</TH>
                  <TH>Model</TH>
                  <TH className="text-right">Tokens</TH>
                  <TH className="text-right">Duration</TH>
                  <TH>Source</TH>
                  <TH className="text-right">When</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() => setSelected(row)}
                  >
                    <TD>
                      <MonoTag hue="cobalt">{row.projectSlug}</MonoTag>
                    </TD>
                    <TD>
                      <div className="flex items-center gap-2">
                        <span className="line-clamp-1 max-w-[28ch] text-fg">{row.query}</span>
                        {row.queryIntent && <Badge tone="neutral">{row.queryIntent}</Badge>}
                        {row.qaRating && <RatingChip rating={row.qaRating} />}
                        {row.error && <Badge tone="red">error</Badge>}
                      </div>
                    </TD>
                    <TD>{row.model ? <MonoTag>{row.model}</MonoTag> : <span className="text-disabled">—</span>}</TD>
                    <TD className="text-right">
                      <Stat>
                        {formatTokens(row.usage?.input_tokens)}→{formatTokens(row.usage?.output_tokens)}
                      </Stat>
                    </TD>
                    <TD className="text-right font-mono text-subtle">{formatDuration(row.durationMs)}</TD>
                    <TD>
                      <Badge tone="neutral">{row.source}</Badge>
                    </TD>
                    <TD className="text-right font-mono text-subtle">
                      {formatRelativeTime(row.createdAt, now)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>

          {/* Mobile: stacked cards — no horizontal page scroll. */}
          <div className="space-y-2.5 md:hidden">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelected(row)}
                className="block w-full rounded-lg border border-line bg-surface px-4 py-3 text-left transition-colors hover:bg-hover"
              >
                <div className="flex items-center justify-between gap-2">
                  <MonoTag hue="cobalt">{row.projectSlug}</MonoTag>
                  <span className="font-mono text-xs text-subtle">
                    {formatRelativeTime(row.createdAt, now)}
                  </span>
                </div>
                <p className="fg-body-sm mt-2 line-clamp-2 text-fg">{row.query}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {row.queryIntent && <Badge tone="neutral">{row.queryIntent}</Badge>}
                  <Badge tone="neutral">{row.source}</Badge>
                  {row.qaRating && <RatingChip rating={row.qaRating} />}
                  {row.error && <Badge tone="red">error</Badge>}
                  <span className="ml-auto font-mono text-xs text-subtle">
                    {formatTokens(row.usage?.input_tokens)}→{formatTokens(row.usage?.output_tokens)}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {/* Pagination footer */}
          <div className="mt-5 flex items-center justify-between">
            <span className="fg-body-sm text-subtle">
              {totalCount.toLocaleString()} conversation{totalCount === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <span className="font-mono text-sm text-muted">
                {page} / {pageCount}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Detail drawer */}
      <SlideOver
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.projectSlug} · ${selected.source}` : undefined}
        width={560}
      >
        {selected && <ActivityDetail row={selected} now={now} />}
      </SlideOver>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line-subtle py-2 last:border-0">
      <span className="fg-overline shrink-0">{label}</span>
      <span className="fg-body-sm text-right text-fg">{children}</span>
    </div>
  );
}

function ActivityDetail({ row, now }: { row: ChatLogRow; now: number }) {
  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {row.queryIntent && <Badge tone="neutral">{row.queryIntent}</Badge>}
        {row.qaRating && <RatingChip rating={row.qaRating} />}
        {row.error && <Badge tone="red">error</Badge>}
        <span className="ml-auto font-mono text-xs text-subtle">
          {formatRelativeTime(row.createdAt, now)}
        </span>
      </div>

      <section className="mt-4">
        <p className="fg-overline mb-1.5">Query</p>
        <Markdown>{row.query}</Markdown>
      </section>

      {row.reply && (
        <section className="mt-4">
          <p className="fg-overline mb-1.5">Reply</p>
          <Markdown>{row.reply}</Markdown>
        </section>
      )}

      {row.error && (
        <section className="mt-4">
          <p className="fg-overline mb-1.5">Error</p>
          <p className="fg-body-sm rounded-md bg-sunken p-3 font-mono text-[color:var(--red-600)]">
            {row.error}
          </p>
        </section>
      )}

      <section className="mt-5">
        <DetailRow label="Model">
          {row.model ? <MonoTag>{row.model}</MonoTag> : "—"}
        </DetailRow>
        <DetailRow label="Input tokens">{formatTokens(row.usage?.input_tokens)}</DetailRow>
        <DetailRow label="Output tokens">{formatTokens(row.usage?.output_tokens)}</DetailRow>
        <DetailRow label="Duration">{formatDuration(row.durationMs)}</DetailRow>
        <DetailRow label="Iterations">{row.iterations}</DetailRow>
        <DetailRow label="Tool calls">{row.toolCalls?.length ?? 0}</DetailRow>
        <DetailRow label="RAG hits">{row.ragContext?.length ?? 0}</DetailRow>
        <DetailRow label="Session">
          <MonoTag>{row.sessionId.slice(0, 12)}</MonoTag>
        </DetailRow>
      </section>
    </div>
  );
}
