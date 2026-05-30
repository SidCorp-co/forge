"use client";

import { MonoTag } from "@/design/primitives/mono-tag";

export interface NotificationItem {
  id: string;
  text: string;
  sub?: string;
  time: string;
  unread?: boolean;
  hue: "amber" | "red" | "green" | "cobalt";
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
}

export function NotificationsMenu({ items, onSelect }: NotificationsMenuProps) {
  return (
    <div className="forge-drop w-[340px] overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
      <div className="flex items-center justify-between border-b border-line-subtle px-4 py-3">
        <span className="fg-label">Notifications</span>
        <button type="button" className="fg-caption text-link hover:underline">
          Mark all read
        </button>
      </div>
      <ul className="max-h-[380px] overflow-y-auto">
        {items.map((n) => (
          <li key={`${n.id}-${n.time}`}>
            <button
              type="button"
              onClick={() => onSelect?.(n.id)}
              className="flex w-full items-start gap-3 border-b border-line-subtle px-4 py-3 text-left transition-colors hover:bg-hover last:border-0"
            >
              <span
                className="mt-1.5 size-2 flex-none rounded-pill"
                style={{ background: n.unread ? HUE_DOT[n.hue] : "var(--border-strong)" }}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <MonoTag>{n.id}</MonoTag>
                  <span className="fg-caption ml-auto">{n.time}</span>
                </div>
                <p className="fg-body-sm mt-1 text-fg">{n.text}</p>
                {n.sub && <p className="fg-caption mt-0.5">{n.sub}</p>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
