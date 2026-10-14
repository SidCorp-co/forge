"use client";

// Settings → Notifications. Delivery preferences (the `@mention` opt-out, the
// only user-initiated notification type produced) persist via
// `/api/auth/me/preferences`; the inbox below lists in-app notifications, narrowed by
// type and by unread on the server before a page is cut, with mark-all-read. A row
// names what it is about and opens it; a sweep's row expands to the records it
// carries, each of which opens its own. Only real, server-enforced controls are
// shown — no fake toggles for unimplemented delivery channels.
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  NativeSelect,
  SectionTitle,
  Skeleton,
  Toggle,
  SettingsSection,
  VirtualList,
} from "@/design";
import type { InboxFilter } from "@/features/notifications/api";
import {
  useMarkAllRead,
  useMarkRead,
  useNotificationInbox,
  useNotificationMembers,
} from "@/features/notifications/hooks";
import { TYPE_FILTER_OPTIONS, TYPE_NAMES } from "@/features/notifications/map";
import { secondaryHref, subjectHref } from "@/features/notifications/subject";
import type { NotificationRow, NotificationType } from "@/features/notifications/types";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import {
  type BrowserPermission,
  getPermission,
  isEnabled,
  requestPermission,
  setEnabled,
  showTestNotification,
} from "@/lib/notifications/browser";
import {
  isEnabled as isSoundEnabled,
  isSupported as isSoundSupported,
  playPreviewCue,
  primeAudio,
  setEnabled as setSoundEnabled,
} from "@/lib/notifications/sound";
import { usePreferences, useUpdatePreferences } from "../hooks";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const ALL_TYPES = "";

export function NotificationsTab() {
  const [filter, setFilter] = useState<InboxFilter>({ type: null, unreadOnly: false });
  const feedQ = useNotificationInbox(filter);
  const markAll = useMarkAllRead();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const rows = feedQ.data?.rows ?? [];
  const totalCount = feedQ.data?.totalCount ?? 0;
  const hasUnread = rows.some((n) => n.unread);
  const narrowed = filter.type !== null || filter.unreadOnly;
  // A failed refresh keeps the rows already read; only a first load that failed has nothing to show.
  const failedToLoad = feedQ.isError && !feedQ.data;

  function toggle(id: string) {
    setExpanded((held) => {
      const next = new Set(held);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function markAllRead() {
    markAll.mutate(undefined, {
      onSuccess: (res) => toast({ title: `Marked ${res.updated} read`, tone: "success" }),
      onError: (err) =>
        toast({ title: "Action failed", description: formatApiError(err), tone: "error" }),
    });
  }

  return (
    <div className="space-y-6">
      <DeliveryPreferences />

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <SectionTitle className="fg-h3">Notifications</SectionTitle>
          {totalCount > 0 && (
            <p className="fg-caption mt-0.5">
              {totalCount === 1
                ? "1 notification"
                : `${totalCount.toLocaleString("en-US")} notifications`}
            </p>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon="check"
          disabled={!hasUnread || markAll.isPending}
          loading={markAll.isPending}
          onClick={markAllRead}
          className="min-h-11"
        >
          Mark all read
        </Button>
      </div>

      <InboxFilterBar filter={filter} onChange={setFilter} />

      {feedQ.isLoading && (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      )}

      {failedToLoad && (
        <ErrorState
          title="Couldn't load notifications"
          message={formatApiError(feedQ.error)}
          onRetry={() => feedQ.refetch()}
        />
      )}

      {!feedQ.isLoading && !failedToLoad && rows.length === 0 && (
        <EmptyState
          title={narrowed ? "Nothing matches" : "All caught up"}
          message={
            narrowed
              ? "No notification matches this filter."
              : "You have no notifications."
          }
        />
      )}

      {rows.length > 0 && (
        <VirtualList
          aria-label="Notifications"
          rows={rows}
          totalCount={totalCount}
          getRowId={(n) => n.id}
          getRowLabel={(n) => n.title}
          estimateRowHeight={96}
          renderRow={(n) => (
            <NotificationItem row={n} open={expanded.has(n.id)} onToggle={() => toggle(n.id)} />
          )}
          more={
            feedQ.hasNextPage
              ? {
                  onLoad: () => void feedQ.fetchNextPage(),
                  loading: feedQ.isFetchingNextPage,
                  failed: feedQ.isFetchNextPageError,
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/** Which notifications the inbox shows: all or unread, and one type or every type. The server
 *  narrows before it pages, so the count above and every page below are of the matches. */
function InboxFilterBar({
  filter,
  onChange,
}: {
  filter: InboxFilter;
  onChange: (next: InboxFilter) => void;
}) {
  return (
    <fieldset aria-label="Filter notifications" className="m-0 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-0 p-0">
      <div className="flex items-center gap-1">
        {([false, true] as const).map((unreadOnly) => (
          <button
            key={String(unreadOnly)}
            type="button"
            aria-pressed={filter.unreadOnly === unreadOnly}
            onClick={() => onChange({ ...filter, unreadOnly })}
            className={
              filter.unreadOnly === unreadOnly
                ? "fg-body-sm min-h-11 border-b-2 border-fg px-3 font-medium text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                : "fg-body-sm min-h-11 border-b-2 border-transparent px-3 text-muted hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            }
          >
            {unreadOnly ? "Unread" : "All"}
          </button>
        ))}
      </div>
      <div className="w-full sm:w-52">
        <NativeSelect
          aria-label="Type"
          className="min-h-11"
          value={filter.type ?? ALL_TYPES}
          onChange={(e) =>
            onChange({
              ...filter,
              type: e.target.value === ALL_TYPES ? null : (e.target.value as NotificationType),
            })
          }
          options={[{ value: ALL_TYPES, label: "All types" }, ...TYPE_FILTER_OPTIONS]}
        />
      </div>
    </fieldset>
  );
}

/** Delivery preferences card — the `@mention` opt-out, persisted via
 *  `/api/auth/me/preferences`. The toggle reflects the server value and writes
 *  on change; React Query keeps it in sync after the mutation resolves. */
function DeliveryPreferences() {
  const prefsQ = usePreferences();
  const update = useUpdatePreferences();

  return (
    <SettingsSection>
      <SectionTitle className="fg-h3 mb-1">Delivery preferences</SectionTitle>
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

      <div className="my-3 border-t border-line" />
      <SoundNotificationsToggle />
    </SettingsSection>
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
  // Opt-in persisted but the browser grant lapsed back to `default` (e.g. the
  // user reset site permissions): the toggle reads OFF while the stored opt-in
  // says ON. Surface the mismatch so it doesn't look silently broken — toggling
  // ON re-requests permission.
  const lapsed = enabled && perm === "default";

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
      // Immediate, observable proof the channel works — high-signal events only
      // surface a native notification while the tab is backgrounded, so without
      // this the user sees nothing on enable and assumes it is broken.
      showTestNotification();
    }
  }

  const helper = !supported
    ? "Your browser does not support desktop notifications."
    : denied
      ? "Blocked in your browser settings — re-enable notifications for this site, then try again."
      : lapsed
        ? "Notifications are off in your browser — toggle on to re-enable them for this site."
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

/** Notification sound toggle (ISS-513). Client-only opt-in (localStorage,
 *  default OFF) for an audible cue that accompanies toast/browser delivery.
 *  Toggling ON primes the AudioContext from this gesture so the autoplay policy
 *  unlocks playback; disables itself with an explanatory caption when the
 *  browser has no Web Audio support. */
function SoundNotificationsToggle() {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabledState] = useState(false);

  // Read support + opt-in on mount (client-only — AudioContext / localStorage).
  useEffect(() => {
    setSupported(isSoundSupported());
    setEnabledState(isSoundEnabled());
  }, []);

  function onToggle(next: boolean) {
    setSoundEnabled(next);
    setEnabledState(next);
    if (next) {
      // Prime the AudioContext on this gesture (autoplay unlock) and play the
      // cue once so the user immediately HEARS proof it works.
      primeAudio();
      playPreviewCue();
    }
  }

  const helper = supported
    ? "Play a sound when a new high-signal notification arrives."
    : "Your browser does not support notification sounds.";

  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <p className="fg-label text-fg">Notification sound</p>
        <p className="fg-caption text-muted">{helper}</p>
      </div>
      <Toggle
        checked={enabled && supported}
        disabled={!supported}
        onChange={onToggle}
        aria-label="Enable notification sound"
      />
    </div>
  );
}

const linkClass =
  "fg-body-sm inline-flex min-h-11 items-center font-medium text-fg hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";
const toggleClass =
  "fg-caption inline-flex min-h-11 items-center text-link hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";

/**
 * One delivery. A row carrying a single record is titled by that record and opens its subject; one
 * carrying several is titled by the cause with its count and opens nothing itself, because its
 * records are the subjects. What a sweep means is said once, in the disclosure, not on every row.
 */
function NotificationItem({
  row,
  open,
  onToggle,
}: {
  row: NotificationRow;
  open: boolean;
  onToggle: () => void;
}) {
  const markRead = useMarkRead();
  const grouped = row.members > 1;
  const href = grouped ? null : subjectHref(row);
  const also = grouped ? null : secondaryHref(row);
  const opened = () => {
    if (row.readAt === null) markRead.mutate(row.id);
  };
  const caption = [row.projectName, TYPE_NAMES[row.type as NotificationType]]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const disclosed = grouped || row.explanation !== null;

  return (
    <div className="py-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            {row.unread && (
              <span className="mt-3">
                <Badge tone="accent">new</Badge>
              </span>
            )}
            {href ? (
              <Link href={href} onClick={opened} className={linkClass}>
                {row.title}
              </Link>
            ) : (
              <p className="fg-body-sm py-3 font-medium text-fg">{row.title}</p>
            )}
          </div>
          {caption && <p className="fg-caption text-muted">{caption}</p>}
          {row.body && <p className="fg-caption mt-1">{row.body}</p>}
          {also && (
            <div>
              <Link href={also} onClick={opened} className={toggleClass}>
                Open the issue it waits on
              </Link>
            </div>
          )}
          {disclosed && (
            <div>
              <button
                type="button"
                aria-expanded={open}
                onClick={onToggle}
                className={toggleClass}
              >
                {grouped
                  ? `${row.openMembers} of ${row.members} still open — ${open ? "hide" : "show"}`
                  : open
                    ? "Hide what this means"
                    : "What this means"}
              </button>
            </div>
          )}
        </div>
        <span className="fg-caption mt-3 flex-none whitespace-nowrap font-mono">
          {fmtTime(row.createdAt)}
        </span>
      </div>
      {open && (
        <div className="pb-2 pl-0">
          {row.explanation && <p className="fg-caption max-w-prose text-muted">{row.explanation}</p>}
          {grouped && <MemberList deliveryId={row.id} onOpened={opened} />}
        </div>
      )}
    </div>
  );
}

/** The records behind a grouped row, still-true ones first, each opening its own subject. */
function MemberList({ deliveryId, onOpened }: { deliveryId: string; onOpened: () => void }) {
  const membersQ = useNotificationMembers(deliveryId);
  if (membersQ.isLoading) return <p className="fg-caption py-2 text-muted">Loading…</p>;
  if (membersQ.isError) {
    return (
      <p className="fg-caption py-2">
        Couldn&apos;t load these.{" "}
        <button type="button" onClick={() => membersQ.refetch()} className="text-link hover:underline">
          Retry
        </button>
      </p>
    );
  }
  return (
    <ul className="mt-1 divide-y divide-line-subtle border-t border-line-subtle">
      {(membersQ.data ?? []).map((m) => {
        const href = subjectHref(m);
        const text = (
          <span className={m.open ? "text-fg" : "text-muted line-through"}>{m.title}</span>
        );
        return (
          <li key={m.id} className="flex items-center justify-between gap-3">
            {href ? (
              <Link href={href} onClick={onOpened} className={`${linkClass} min-w-0 font-normal`}>
                {text}
              </Link>
            ) : (
              <span className="fg-body-sm py-3">{text}</span>
            )}
            <span className="fg-caption flex-none whitespace-nowrap font-mono">
              {fmtTime(m.createdAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
