"use client";

// Settings → Notifications. Delivery preferences (the `@mention` opt-out, the
// only user-initiated notification type produced) persist via
// `/api/auth/me/preferences`; the feed below lists in-app notifications with
// mark-all-read. Only real, server-enforced controls are shown — no fake
// toggles for unimplemented delivery channels.
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Pagination,
  Skeleton,
  Toggle,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import {
  type BrowserPermission,
  getPermission,
  isEnabled,
  requestPermission,
  setEnabled,
} from "@/lib/notifications/browser";
import { NOTIFICATIONS_PAGE_SIZE } from "../api";
import {
  useMarkAllRead,
  useNotifications,
  usePreferences,
  useUpdatePreferences,
} from "../hooks";
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
      <DeliveryPreferences />

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

/** Delivery preferences card — the `@mention` opt-out, persisted via
 *  `/api/auth/me/preferences`. The toggle reflects the server value and writes
 *  on change; React Query keeps it in sync after the mutation resolves. */
function DeliveryPreferences() {
  const prefsQ = usePreferences();
  const update = useUpdatePreferences();

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Delivery preferences</h2>
        <p className="fg-caption mb-4">Choose which notifications Forge sends you.</p>

        {prefsQ.isLoading && <Skeleton className="h-11 w-full rounded-md" />}

        {prefsQ.isError && (
          <ErrorState
            title="Couldn't load preferences"
            message={formatApiError(prefsQ.error)}
            onRetry={() => prefsQ.refetch()}
          />
        )}

        {prefsQ.data && (
          <div className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <p className="fg-label text-fg">Mentions</p>
              <p className="fg-caption text-muted">
                Notify me when someone @mentions me in a comment.
              </p>
            </div>
            <Toggle
              checked={prefsQ.data.notifyOnMention}
              disabled={update.isPending}
              onChange={(checked) => update.mutate({ notifyOnMention: checked })}
              aria-label="Notify me when I'm mentioned"
            />
          </div>
        )}

        <div className="my-3 border-t border-line" />
        <DesktopNotificationsToggle />
      </CardContent>
    </Card>
  );
}

/** Desktop (browser/OS) notifications toggle (ISS-510). Client-only: combines
 *  the browser permission grant with an explicit localStorage opt-in. Toggling
 *  ON requests permission via this gesture; the control reflects the live
 *  permission state and disables itself when denied or unsupported. */
function DesktopNotificationsToggle() {
  const [perm, setPerm] = useState<BrowserPermission>("default");
  const [enabled, setEnabledState] = useState(false);

  // Read live permission + opt-in on mount (client-only — Notification API).
  useEffect(() => {
    setPerm(getPermission());
    setEnabledState(isEnabled());
  }, []);

  const supported = perm !== "unsupported";
  const denied = perm === "denied";
  const checked = enabled && perm === "granted";

  async function onToggle(next: boolean) {
    if (!next) {
      setEnabled(false);
      setEnabledState(false);
      return;
    }
    let p = getPermission();
    if (p === "default") p = await requestPermission();
    setPerm(p);
    if (p === "granted") {
      setEnabled(true);
      setEnabledState(true);
    }
  }

  const helper = !supported
    ? "Your browser does not support desktop notifications."
    : denied
      ? "Blocked in your browser settings — re-enable notifications for this site, then try again."
      : "Show a desktop notification for high-signal events when this tab is in the background.";

  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <p className="fg-label text-fg">Desktop notifications</p>
        <p className="fg-caption text-muted">{helper}</p>
      </div>
      <Toggle
        checked={checked}
        disabled={!supported || denied}
        onChange={onToggle}
        aria-label="Enable desktop notifications"
      />
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
