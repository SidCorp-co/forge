'use client';

import { MessageCircle } from 'lucide-react';
import { useParams, usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { useProjectChatState } from '@/features/project-chat';
import { cn } from '@/lib/utils/cn';
import { ProjectChatPanel } from './project-chat-panel';

/**
 * Floating chat affordance mounted on every project sub-page (except `/agent`,
 * which already owns the full chat surface). Shares the layout-level
 * `AgentStreamProvider` so a `prompt.draft` arriving over WS auto-opens the
 * panel and the badge flags the un-acknowledged turn.
 */
export function ProjectChatBubble() {
  const params = useParams<{ slug?: string }>();
  const slug = params.slug ?? '';
  const pathname = usePathname() ?? '';
  const isAgentPage = !!slug && pathname === `/projects/${slug}/agent`;

  const { isOpen, open, toggle } = useProjectChatState();
  const { draftPrompt } = useAgentStreamContext();

  const [hasUnread, setHasUnread] = useState(false);
  const prevDraftRef = useRef<string | null>(null);
  const didMountRef = useRef(false);

  // Auto-open when a draft prompt transitions null → string while bubble is
  // closed. Skip on /agent — the page itself handles the draft. Capture the
  // initial draftPrompt on mount (without firing) so navigating to a page that
  // already had a pending draft doesn't auto-open every time.
  useEffect(() => {
    if (isAgentPage) return;
    if (!didMountRef.current) {
      didMountRef.current = true;
      prevDraftRef.current = draftPrompt ?? null;
      return;
    }
    const prev = prevDraftRef.current;
    prevDraftRef.current = draftPrompt ?? null;
    if (prev || !draftPrompt) return;
    if (!isOpen) {
      open({ tab: 'chat' });
      setHasUnread(true);
    }
  }, [draftPrompt, isOpen, open, isAgentPage]);

  useEffect(() => {
    if (isOpen) setHasUnread(false);
  }, [isOpen]);

  if (!slug || isAgentPage) return null;

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label={isOpen ? 'Close project chat' : 'Open project chat'}
        className={cn(
          'fixed right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-on-primary shadow-lg transition-transform hover:scale-105',
          'bottom-[max(1rem,env(safe-area-inset-bottom))]',
          isOpen && 'scale-95',
        )}
      >
        <MessageCircle className="h-5 w-5" />
        {hasUnread && !isOpen && (
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-error ring-2 ring-surface" />
        )}
      </button>
      {isOpen && <ProjectChatPanel projectSlug={slug} />}
    </>
  );
}
