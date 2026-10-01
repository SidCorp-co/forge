"use client";

import { Button, useTopBarSlotTargets } from "@/design";
import { DOCK_TITLE } from "@/features/conversations/components/chat-dock";

// cm:why the page's title and primary actions are portalled in by the page itself (PageTitle, TopBarActions), so the bar has no per-route knowledge
// cm:why Ask Agent is desktop-only: below md the bottom tabs carry it, and a second entry there would be the same control twice
export function ShellTopBar({ chatOpen, onToggleChat }: { chatOpen: boolean; onToggleChat: () => void }) {
  const { titleRef, actionsRef } = useTopBarSlotTargets();
  return (
    <header className="flex h-12 flex-none items-center gap-3 border-b border-line bg-surface px-4 sm:px-6">
      <div ref={titleRef} className="flex min-w-0 flex-1 items-center gap-2" />
      <div ref={actionsRef} className="flex flex-none items-center gap-2" />
      <Button
        type="button"
        variant={chatOpen ? "primary" : "secondary"}
        size="sm"
        icon="chat"
        aria-pressed={chatOpen}
        onClick={onToggleChat}
        className="hidden md:inline-flex"
      >
        {DOCK_TITLE}
      </Button>
    </header>
  );
}
