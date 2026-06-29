"use client";

import { Button } from "@/design/primitives/button";
import { MonoTag } from "@/design/primitives/mono-tag";

export interface NotificationAction {
  id: string;
  label: string;
  variant: "primary" | "ghost";
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}

export interface NotificationItem {
  id: string;
  /** Short type label shown in the leading tag (e.g. "STATUS", "MENTION"). */
  label: string;
  text: string;
  sub?: string;
  time: string;
  unread?: boolean;
  hue: "amber" | "red" | "green" | "cobalt";
  /** Optional inline action buttons (e.g. Accept / Decline for invitations). */
  actions?: NotificationAction[];
}

const HUE_DOT: Record<NotificationItem["hue"], string> = {
  amber: "var(--amberw-500)",
  red: "var(--red-500)",
  green: "var(--green-500)",
  cobalt: "var(--cobalt-500)",
};

export interface NotificationsMenuProps {
  items: NotificationItem[];
  onSelect?: (id: string) => void;
  onMarkAllRead?: () => void;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

export function NotificationsMenu({
  items,
  onSelect,
  onMarkAllRead,
  loading,
  error,
  onRetry,
}: NotificationsMenuProps) {
  const hasItems = items.length > 0;
  return (
    <div className="forge-drop w-[340px] overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
      <div className="flex items-center justify-between border-b border-line-subtle px-4 py-3">
        <span className="fg-label">Notifications</span>
        <button
          type="button"
          onClick={onMarkAllRead}
          disabled={!onMarkAllRead || !hasItems}
          className="fg-caption text-link hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline"
        >
          Mark all read
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 px-4 py-8 text-muted">
          <span className="size-3.5 animate-spin rounded-pill border-2 border-line border-t-transparent" />
          <span className="fg-caption">Loading…</span>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <p className="fg-body-sm text-fg">Couldn't load notifications.</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="fg-caption text-link hover:underline"
            >
              Retry
            </button>
          )}
        </div>
      ) : !hasItems ? (
        <div className="px-4 py-8 text-center">
          <p className="fg-body-sm text-fg">You're all caught up</p>
          <p className="fg-caption mt-0.5">New pipeline and issue events show up here.</p>
        </div>
      ) : (
        <ul className="max-h-[380px] overflow-y-auto">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onSelect?.(n.id)}
                className="flex w-full items-start gap-3 border-b border-line-subtle px-4 py-3 text-left transition-colors hover:bg-hover last:border-0"
              >
                <span
                  className="mt-1.5 size-2 flex-none rounded-pill"
                  style={{ background: n.unread ? HUE_DOT[n.hue] : "var(--border-strong)" }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <MonoTag>{n.label}</MonoTag>
                    <span className="fg-caption ml-auto">{n.time}</span>
                  </div>
                  <p className="fg-body-sm mt-1 text-fg">{n.text}</p>
                  {n.sub && <p className="fg-caption mt-0.5">{n.sub}</p>}
                  {n.actions && n.actions.length > 0 && (
                    <div
                      className="mt-2 flex items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {n.actions.map((action) => (
                        <Button
                          key={action.id}
                          type="button"
                          variant={action.variant}
                          size="sm"
                          loading={action.loading}
                          disabled={action.disabled}
                          onClick={action.onClick}
                        >
                          {action.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
