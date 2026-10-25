
import { Button, useTopBarSlotTargets } from "@/design";
import { dockTitle } from "@/features/conversations";
import { FeedbackButton } from "@/features/feedback";
import { useForgeVersion } from "@/features/version";
import { useCopy } from "@/lib/i18n/interface-language";

// the page's title and primary actions are portalled in by the page itself (PageTitle, TopBarActions), so the bar has no per-route knowledge
// Feedback is on every page (REQ-66 BC-1, REQ-47 BC-9): about the project the page is in, or about Forge
// Ask Agent is desktop-only: below md the bottom tabs carry it, and a second entry there would be the same control twice
// below 768px of page column (a page beside the open panel) it is its icon alone, so the page's acts never cover the back control
// open, it reads as pressed rather than turning primary: the page's one primary action keeps that colour (prototype-gap-audit)
export function ShellTopBar({ chatOpen, onToggleChat }: { chatOpen: boolean; onToggleChat: () => void }) {
  const { titleRef, actionsRef } = useTopBarSlotTargets();
  const t = useCopy();
  const version = useForgeVersion().data?.version?.trim();
  return (
    <header className="flex h-12 flex-none items-center gap-3 border-b border-line bg-surface px-4 sm:px-6">
      <div ref={titleRef} className="flex min-w-0 flex-1 items-center gap-2" />
      <div ref={actionsRef} className="flex flex-none items-center gap-2" />
      <FeedbackButton clientVersion={version ? `web ${version}` : undefined} />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon="chat"
        aria-pressed={chatOpen}
        aria-label={dockTitle(t)}
        onClick={onToggleChat}
        className="hidden window-md:inline-flex aria-pressed:bg-active aria-pressed:text-fg"
      >
        <span className="max-column-md:sr-only">{dockTitle(t)}</span>
      </Button>
    </header>
  );
}
