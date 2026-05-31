"use client";

// Settings → Notifications. There is no per-user notification-preferences API,
// so this tab surfaces the real controls that exist (the notification feed +
// mark-all-read) and is explicit that delivery preferences aren't configurable
// yet — no fake toggles.
import { useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Pagination,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { NOTIFICATIONS_PAGE_SIZE } from "../api";
import { useMarkAllRead, useNotifications } from "../hooks";
import type { NotificationRow } from "../types";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function NotificationsTab() {
  const [page, setPage] = useState(1);
  const notificationsQ = useNotifications(page);
  const markAll = useMarkAllRead();

  const rows = notificationsQ.data?.items ?? [];
  const totalCount = notificationsQ.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / NOTIFICATIONS_PAGE_SIZE));
  const hasUnread = rows.some((n) => !n.read);

  return (
    <div className="space-y-6">
      <Banner tone="info">
        Delivery preferences aren&apos;t configurable yet. Your in-app notifications are below.
      </Banner>

      <div className="flex items-center justify-between gap-3">
        <h2 className="fg-h3">Notifications</h2>
        <Button
          variant="secondary"
          size="sm"
          icon="check"
          disabled={!hasUnread || markAll.isPending}
          loading={markAll.isPending}
          onClick={() => markAll.mutate()}
          className="min-h-11"
        >
          Mark all read
        </Button>
      </div>

      {notificationsQ.isLoading && (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      )}

      {notificationsQ.isError && (
        <ErrorState
          title="Couldn't load notifications"
          message={formatApiError(notificationsQ.error)}
          onRetry={() => notificationsQ.refetch()}
        />
      )}

      {!notificationsQ.isLoading && !notificationsQ.isError && rows.length === 0 && (
        <EmptyState title="All caught up" message="You have no notifications." />
      )}

      {!notificationsQ.isLoading && !notificationsQ.isError && rows.length > 0 && (
        <div className="space-y-2.5">
          {rows.map((n) => (
            <NotificationCard key={n.id} row={n} />
          ))}
        </div>
      )}

      {totalCount > NOTIFICATIONS_PAGE_SIZE && (
        <div className="flex justify-center">
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </div>
      )}
    </div>
  );
}

function NotificationCard({ row }: { row: NotificationRow }) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {!row.read && <Badge tone="accent">new</Badge>}
              <p className="fg-body-sm font-medium text-fg">{row.title}</p>
            </div>
            {row.body && <p className="fg-caption mt-1">{row.body}</p>}
          </div>
          <span className="fg-caption flex-none whitespace-nowrap font-mono">
            {fmtTime(row.createdAt)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
