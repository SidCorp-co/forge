"use client";

import { Button } from "@/design";
import { DOCK_TITLE } from "@/features/conversations/components/chat-dock";

// cm:why the bar is desktop-only: below md the bottom tabs carry Ask Agent, and a second entry there would be the same control twice
export function ShellTopBar({ chatOpen, onToggleChat }: { chatOpen: boolean; onToggleChat: () => void }) {
  return (
    <header className="hidden h-12 flex-none items-center justify-end gap-2 border-b border-line bg-surface px-4 sm:px-6 md:flex">
      <Button
        type="button"
        variant={chatOpen ? "primary" : "secondary"}
        size="sm"
        icon="chat"
        aria-pressed={chatOpen}
        onClick={onToggleChat}
      >
        {DOCK_TITLE}
      </Button>
    </header>
  );
}
