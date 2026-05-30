"use client";

import { Icon } from "@/design/icons/icon";
import { Button } from "@/design/primitives/button";
import { Kbd } from "@/design/primitives/kbd";

export interface TopBarProps {
  title?: string;
  notificationCount?: number;
  onCommandPalette?: () => void;
  onNotifications?: () => void;
  onNewIssue?: () => void;
}

export function TopBar({
  title,
  notificationCount = 0,
  onCommandPalette,
  onNotifications,
  onNewIssue,
}: TopBarProps) {
  return (
    <header className="flex h-14 flex-none items-center gap-3 border-b border-line bg-surface px-5">
      {title && <h1 className="fg-h3 mr-2">{title}</h1>}

      <button
        type="button"
        onClick={onCommandPalette}
        className="flex h-9 max-w-md flex-1 items-center gap-2.5 rounded-md border border-line-strong bg-surface px-3 text-subtle transition-colors hover:border-[color:var(--link)] hover:bg-hover"
      >
        <Icon name="search" size={16} />
        <span className="fg-body-sm flex-1 text-left">Search or jump to…</span>
        <Kbd>⌘K</Kbd>
      </button>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onNotifications}
          className="relative inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
          aria-label="Notifications"
        >
          <Icon name="bell" size={18} />
          {notificationCount > 0 && (
            <span
              className="absolute right-1.5 top-1.5 inline-flex min-w-[15px] items-center justify-center rounded-pill px-1 text-[10px] font-bold text-white"
              style={{ background: "var(--flame-500)" }}
            >
              {notificationCount}
            </span>
          )}
        </button>
        <Button variant="primary" size="sm" icon="plus" onClick={onNewIssue}>
          New issue
        </Button>
      </div>
    </header>
  );
}
