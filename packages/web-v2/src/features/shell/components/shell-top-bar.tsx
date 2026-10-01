"use client";

import { Button } from "@/design";

// cm:why the bar is desktop-only: below md the bottom tabs carry Chat, and a second entry there would be the same control twice
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
        Chat
      </Button>
    </header>
  );
}
