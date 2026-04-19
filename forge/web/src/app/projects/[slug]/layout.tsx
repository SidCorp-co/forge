'use client';

import { Shell } from '@/components/layout/shell';
import { useProject } from '@/features/project/hooks/use-projects';
import { ProjectChat } from '@/components/chat/project-chat';
import { AgentStreamProvider } from '@/hooks/agent-stream-context';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { useAgentStreamContext } from '@/hooks/agent-stream-context';
import { useState, useEffect, type ReactNode } from 'react';
import { MessageCircle, X } from 'lucide-react';

/** Auto-navigate to agent page when a preview prompt arrives via WS */
function PreviewPromptNavigator({ slug }: { slug: string }) {
  const { draftPrompt } = useAgentStreamContext();
  const router = useRouter();
  const pathname = usePathname();
  const agentPath = `/projects/${slug}/agent`;

  useEffect(() => {
    if (draftPrompt && pathname !== agentPath) {
      router.push(agentPath);
    }
  }, [draftPrompt, pathname, agentPath, router]);

  return null;
}

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const pathname = usePathname();
  const { data, isLoading } = useProject(slug);
  const project = data?.data;
  const base = `/projects/${slug}`;
  const [chatOpen, setChatOpen] = useState(false);
  const isAgentPage = pathname === `${base}/agent`;
  // Extract issue ID when on an issue detail page for chat context
  const issueMatch = pathname.match(new RegExp(`^${base}/issues/([^/]+)$`));
  const activeIssueId = issueMatch?.[1] ?? undefined;
  useSetPageTitle(project?.name ?? '');

  return (
    <Shell>
      {isLoading ? (
        <p className="text-sm text-primary-fixed">Loading project...</p>
      ) : !project ? (
        <p className="text-sm text-primary-fixed">Project not found.</p>
      ) : (
        <AgentStreamProvider projectSlug={slug}>
          <PreviewPromptNavigator slug={slug} />
          <div className={cn('flex flex-1 min-h-0 overflow-hidden gap-0', isAgentPage && 'bg-background')}>
            {/* Main content */}
            <div className={cn(
              'flex-1 min-w-0 min-h-0 flex flex-col',
              isAgentPage ? 'overflow-hidden' : 'overflow-y-auto overflow-x-hidden px-2 py-3 sm:p-6',
              chatOpen && 'hidden md:flex md:border-r border-outline-variant/30'
            )}>
              {children}
            </div>

            {/* Chat sidebar — full screen on mobile, side panel on md+ */}
            {chatOpen && (
              <div className="flex w-full min-h-0 flex-1 flex-col bg-surface border-l border-outline-variant/30 md:w-96 md:flex-none lg:w-[28rem] xl:w-[32rem]">
                <ProjectChat
                  projectSlug={slug}
                  activeIssueId={activeIssueId}
                  onClose={() => setChatOpen(false)}
                />
              </div>
            )}
          </div>

          {/* Floating chat bubble */}
          {!chatOpen && (
            <button
              onClick={() => setChatOpen(true)}
              className="fixed bottom-[1.5rem] right-[1.5rem] md:bottom-8 md:right-8 z-50 flex h-14 w-14 items-center justify-center rounded-sm bg-primary text-on-primary shadow-2xl hover:bg-tertiary hover:scale-105 active:scale-95 transition-all"
              aria-label="Open chat"
            >
              <MessageCircle className="h-6 w-6 fill-current" />
            </button>
          )}
        </AgentStreamProvider>
      )}
    </Shell>
  );
}
