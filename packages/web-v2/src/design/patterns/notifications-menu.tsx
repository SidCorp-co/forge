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
  /** Short type label shown in the leading tag (e.g. "STATUS", "MENTION"); none where the row has no words for one. */
  label?: string;
  text: string;
  sub?: string;
  time: string;
  unread?: boolean;
  hue: "amber" | "red" | "green" | "cobalt";
  /** Optional inline action buttons (e.g. Accept / Decline for invitations). */
  actions?: NotificationAction[];
  /** ISS-1063 — set when this row is one delivery carrying several records. */
  /** A delivery grouping several records: how many it lists, and whether those are the ones still
   *  open (a resolved condition has left the group) or events, which cannot end. */
  group?: { count: number; open: boolean };
}

/** A record behind an expanded grouped row. */
export interface NotificationGroupMember {
  id: string;
  text: string;
  /** The record's own sentence, under its title. */
  sub?: string;
  time: string;
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
  /** Why the notifications could not be read, in the product's words. */
  errorWhy?: string | undefined;
  onRetry?: () => void;
  // ISS-1063 — grouping is what turns fifteen bell rows into one, so the members
  // have to stay reachable or the grouping is a loss of information rather than a
  // saving of attention. The menu owns the disclosure; the feature owns the fetch.
  /** Which grouped row is expanded, and what it holds. */
  expandedId?: string | null;
  expandedMembers?: NotificationGroupMember[];
  expandedLoading?: boolean;
  /** Why the expanded group's records could not be read, and the act that reads them again (ISS-1229 r48). */
  expandedUnread?: { why: string; onRetry: () => void } | null;
  onToggleGroup?: (id: string) => void;
  onSelectMember?: (memberId: string) => void;
}

export function NotificationsMenu({
  items,
  onSelect,
  onMarkAllRead,
  loading,
  error,
  errorWhy,
  onRetry,
  expandedId,
  expandedMembers,
  expandedLoading,
  expandedUnread = null,
  onToggleGroup,
  onSelectMember,
}: NotificationsMenuProps) {
  const hasItems = items.length > 0;
  return (
    <div className="forge-drop w-[340px] overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
      <div className="flex items-center justify-between border-b border-line-subtle px-4">
        <span className="fg-label">Notifications</span>
        <button
          type="button"
          onClick={onMarkAllRead}
          disabled={!onMarkAllRead || !hasItems}
          className="fg-caption inline-flex min-h-11 items-center text-link hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline"
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
          <p className="fg-body-sm text-fg">{errorWhy ? `Couldn't load notifications. ${errorWhy}` : "Couldn't load notifications."}</p>
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
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelect?.(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect?.(n.id);
                  }
                }}
                className="flex w-full cursor-pointer items-start gap-3 border-b border-line-subtle px-4 py-3 text-left transition-colors hover:bg-hover last:border-0 focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
              >
                <span
                  className="mt-1.5 size-2 flex-none rounded-pill"
                  style={{ background: n.unread ? HUE_DOT[n.hue] : "var(--border-strong)" }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {n.label && <MonoTag>{n.label}</MonoTag>}
                    <span className="fg-caption ml-auto">{n.time}</span>
                  </div>
                  <p className="fg-body-sm mt-1 text-fg">{n.text}</p>
                  {n.sub && <p className="fg-caption mt-0.5 whitespace-pre-line">{n.sub}</p>}
                  {n.group && (
                    <div className="mt-1.5">
                      {/* The row itself is clickable, so every control inside it stops the
                          event on the control — a wrapper div carrying the handlers would be
                          a second static element with interactions in a file already
                          carrying one. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleGroup?.(n.id);
                        }}
                        disabled={!onToggleGroup}
                        className="fg-caption inline-flex min-h-11 items-center text-link hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline"
                      >
                        {n.group.open ? `${n.group.count} still open` : `${n.group.count} in all`}
                        {expandedId === n.id ? " — hide" : " — show"}
                      </button>
                      {expandedId === n.id && (
                        <ul className="mt-1.5 border-l border-line-subtle pl-2.5">
                          {expandedLoading && <li className="fg-caption py-1">Loading…</li>}
                          {!expandedLoading && expandedUnread && (
                            <li role="alert" data-testid="group-members-unread" className="fg-caption py-1 text-fg">
                              Couldn&apos;t load this group&apos;s notifications. {expandedUnread.why}{" "}
                              <button
                                type="button"
                                aria-label="Retry this group"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  expandedUnread.onRetry();
                                }}
                                className="inline-flex min-h-11 items-center text-link hover:underline"
                              >
                                Retry
                              </button>
                            </li>
                          )}
                          {!expandedLoading &&
                            !expandedUnread &&
                            (expandedMembers ?? []).map((m) => (
                              <li key={m.id}>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onSelectMember?.(m.id);
                                  }}
                                  className="flex min-h-11 w-full items-center py-1 text-left hover:underline"
                                >
                                  <span className="flex min-w-0 flex-col">
                                    <span className="fg-caption text-fg">{m.text}</span>
                                    {m.sub && <span className="fg-caption text-muted">{m.sub}</span>}
                                  </span>
                                  <span className="fg-caption ml-2 flex-none whitespace-nowrap text-muted">{m.time}</span>
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>
                  )}
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
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
