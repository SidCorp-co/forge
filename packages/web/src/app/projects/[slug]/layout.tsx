'use client';

import { useParams, usePathname } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { ProjectChatBubble } from '@/components/message-bubble/project-chat-bubble';
import { Shell } from '@/components/layout/shell';
import { UnblockToastSurface } from '@/features/issue/components/unblock-toast-surface';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { AgentStreamProvider } from '@/hooks/agent-stream-context';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { projectRoom } from '@/lib/ws/rooms';
import { useRoom } from '@/lib/ws/use-room';
import { cn } from '@/lib/utils/cn';

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const pathname = usePathname();
  const project = useProjectBySlug(slug);
  useRoom(project ? projectRoom(project.id) : null);
  const base = `/projects/${slug}`;
  const isAgentPage = pathname === `${base}/agent`;
  useSetPageTitle(project?.name ?? '');

  return (
    <Shell>
      {!project ? (
        <p className="text-sm text-primary-fixed">Loading project...</p>
      ) : (
        <AgentStreamProvider projectSlug={slug}>
          <div
            className={cn(
              'flex flex-1 min-h-0 overflow-hidden gap-0',
              isAgentPage && 'bg-background',
            )}
          >
            <div
              className={cn(
                'flex-1 min-w-0 min-h-0 flex flex-col',
                isAgentPage
                  ? 'overflow-hidden'
                  : 'overflow-y-auto overflow-x-hidden px-2 py-3 sm:p-6',
              )}
            >
              {children}
            </div>
          </div>
          {/* Suspense boundary keeps useSearchParams() (used inside the bubble
              via useProjectChatState) from forcing the whole layout into
              fully-dynamic rendering under Next 16. */}
          <Suspense fallback={null}>
            <ProjectChatBubble />
          </Suspense>
          <UnblockToastSurface projectSlug={slug} />
        </AgentStreamProvider>
      )}
    </Shell>
  );
}
