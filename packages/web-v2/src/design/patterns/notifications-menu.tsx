"use client";

import { useState } from "react";
import { Button } from "@/design/primitives/button";
import { EnumBadge, ToneBadge } from "@/design/primitives/enum-badge";

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
  /** The entity it names (`ISS-12`, a project slug), from core's payload; never parsed from the text. */
  subjectKey?: string;
  /** The notification type, drawn as an EnumBadge (`issue_stranded` reads "Stranded"). */
  type: string;
  /** The thing it told of has cleared. */
  resolved?: boolean;
  /** The one line beside the key. */
  text: string;
  /** The long body, behind the row's Details expander. */
  sub?: string;
  time: string;
  unread?: boolean;
  hue: "amber" | "red" | "green" | "cobalt";
  /** Optional inline action buttons (e.g. Accept / Decline for invitations). */
  actions?: NotificationAction[];
  /** ISS-1063 — set when this row is one delivery carrying several records. */
  group?: { total: number; open: number };
}

/** A record behind an expanded grouped row. */
export interface NotificationGroupMember {
  id: string;
  text: string;
  time: string;
  open: boolean;
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
  // ISS-1063 — grouping is what turns fifteen bell rows into one, so the members
  // have to stay reachable or the grouping is a loss of information rather than a
  // saving of attention. The menu owns the disclosure; the feature owns the fetch.
  /** Which grouped row is expanded, and what it holds. */
  expandedId?: string | null;
  expandedMembers?: NotificationGroupMember[];
  expandedLoading?: boolean;
  onToggleGroup?: (id: string) => void;
  onSelectMember?: (memberId: string) => void;
}

function GroupMembers({
  item,
  expanded,
  members,
  loading,
  onToggle,
  onSelectMember,
}: {
  item: NotificationItem & { group: { total: number; open: number } };
  expanded: boolean;
  members: NotificationGroupMember[] | undefined;
  loading: boolean | undefined;
  onToggle: ((id: string) => void) | undefined;
  onSelectMember: ((memberId: string) => void) | undefined;
}) {
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => onToggle?.(item.id)}
        disabled={!onToggle}
        aria-expanded={expanded}
        className="fg-caption text-link hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline"
      >
        {`${item.group.open} of ${item.group.total} still open`}
        {expanded ? " · hide" : " · show"}
      </button>
      {expanded && (
        <ul className="mt-1 border-l border-line-subtle pl-2.5">
          {loading && <li className="fg-caption py-1">Loading…</li>}
          {!loading &&
            (members ?? []).map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onSelectMember?.(m.id)}
                  className="block w-full py-1 text-left hover:underline"
                >
                  <span className={`fg-caption ${m.open ? "text-fg" : "text-muted line-through"}`}>{m.text}</span>
                  <span className="fg-caption ml-2 text-muted">{m.time}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

// cm:why a row reads as the prototype's: the entity key, one line and the age, with the type as an
// EnumBadge; the long body sits behind Details, closed by default (REQ-11 BC-9, BC-15)
export function NotificationsMenu({
  items,
  onSelect,
  onMarkAllRead,
  loading,
  error,
  onRetry,
  expandedId,
  expandedMembers,
  expandedLoading,
  onToggleGroup,
  onSelectMember,
}: NotificationsMenuProps) {
  const [details, setDetails] = useState<ReadonlySet<string>>(new Set());
  const toggleDetails = (id: string) =>
    setDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const hasItems = items.length > 0;
  return (
    <div className="forge-drop w-[360px] max-w-[calc(100vw-24px)] overflow-hidden rounded-lg border border-line-strong bg-surface">
      <div className="flex items-center justify-between border-b border-line-subtle px-3 py-2.5">
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
            <button type="button" onClick={onRetry} className="fg-caption text-link hover:underline">
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
        <ul className="max-h-[420px] overflow-y-auto">
          {items.map((n) => {
            const open = details.has(n.id);
            return (
              <li
                key={n.id}
                data-testid="notification-row"
                className="grid grid-cols-[8px_minmax(0,1fr)] gap-x-2.5 border-b border-line-subtle px-3 py-2.5 transition-colors last:border-0 hover:bg-hover"
              >
                <span
                  aria-hidden
                  className="mt-[7px] size-2 rounded-pill"
                  style={{ background: n.unread ? HUE_DOT[n.hue] : "var(--border-strong)" }}
                />
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onSelect?.(n.id)}
                    className="flex w-full min-w-0 items-baseline gap-2 rounded-sm text-left focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
                  >
                    {n.subjectKey && (
                      <span className="flex-none font-mono text-12 font-semibold text-link" data-testid="notification-key">
                        {n.subjectKey}
                      </span>
                    )}
                    <span className="fg-body-sm min-w-0 flex-1 truncate text-fg" title={n.text}>
                      {n.text}
                    </span>
                    <span className="fg-caption flex-none whitespace-nowrap text-subtle">{n.time}</span>
                  </button>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <EnumBadge family="notificationType" value={n.type} />
                    {n.resolved && (
                      <ToneBadge tone="done" label="Resolved" glyph="✓" title="resolved: what this told of has cleared" />
                    )}
                    {n.sub && (
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => toggleDetails(n.id)}
                        className="fg-caption text-link hover:underline"
                      >
                        {open ? "Hide details" : "Details"}
                      </button>
                    )}
                  </div>
                  {open && n.sub && (
                    <p className="fg-caption mt-1.5 whitespace-pre-line break-words text-muted" data-testid="notification-details">
                      {n.sub}
                    </p>
                  )}
                  {n.group && (
                    <GroupMembers
                      item={{ ...n, group: n.group }}
                      expanded={expandedId === n.id}
                      members={expandedMembers}
                      loading={expandedLoading}
                      onToggle={onToggleGroup}
                      onSelectMember={onSelectMember}
                    />
                  )}
                  {n.actions && n.actions.length > 0 && (
                    <div className="mt-2 flex items-center gap-2">
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
