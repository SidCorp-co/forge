"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { ErrorState, Icon, IconButton, ProjectLoader, SlideOver } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { chatConversationId, chatPath, chatSlug } from "@/features/shell/mode";
import { formatApiError } from "@/lib/api/error";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { aboutDraft } from "../ask-about";
import { useConversation } from "../hooks";
import { ChatSidebar } from "./chat-sidebar";
import { ContextPanel } from "./context-panel";
import { ConversationChat } from "./conversation-chat";
import { StartConversation } from "./start-conversation";

function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

function ScopeChip({ name }: { name: string }) {
  return (
    <span
      data-testid="scope-chip"
      className="fg-caption inline-flex max-w-[12rem] items-center gap-1 rounded-pill border border-line bg-sunken px-2 py-0.5 text-muted"
    >
      <Icon name="folder" size={12} className="flex-none" />
      <span className="truncate">{name}</span>
    </span>
  );
}

// cm:why the draft's first send moves the route onto the room it opened; that move must not remount the chat, or the message still being sent and its outbox would be thrown away, so the mount key changes only when the route changes for any other reason
function useChatMountKey(routeKey: string, conversationId: string | null) {
  const adopted = useRef<string | null>(null);
  const key = useRef({ route: routeKey, n: 0 });
  if (key.current.route !== routeKey) {
    const followed = conversationId !== null && conversationId === adopted.current;
    key.current = { route: routeKey, n: followed ? key.current.n : key.current.n + 1 };
    adopted.current = null;
  }
  const adopt = useCallback((id: string) => {
    adopted.current = id;
  }, []);
  return { mountKey: key.current.n, adopt };
}

export function ChatScreen() {
  const router = useRouter();
  const pathname = usePathname() || "/chat";
  const search = useLocationSearch();
  const slug = chatSlug(pathname);
  const conversationId = chatConversationId(pathname);
  const projectsQ = useProjects();
  const [listOpen, setListOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const { mountKey, adopt } = useChatMountKey(`${slug}/${conversationId ?? ""}`, conversationId);
  const roomQ = useConversation(conversationId ?? undefined);
  const said = (roomQ.data?.messages.length ?? 0) + (roomQ.data?.windows.filter((w) => w.closedAt).length ?? 0);

  const go = useCallback(
    (href: string) => {
      setListOpen(false);
      router.push(href);
    },
    [router],
  );

  const mobileList = (
    <SlideOver open={listOpen} onClose={() => setListOpen(false)} hideHeader fitBody width="min(88vw, 320px)">
      <div className="flex h-full min-h-0 flex-col p-3">
        <ChatSidebar slug={slug} conversationId={conversationId} onNavigate={go} />
      </div>
    </SlideOver>
  );
  const listButton = (
    <IconButton icon="list" size="sm" aria-label="Conversations" className="md:hidden" onClick={() => setListOpen(true)} />
  );

  if (!slug) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-none items-center justify-between border-b border-line px-4 py-3 md:hidden">
          <span className="fg-h3">Chat</span>
          {listButton}
        </div>
        <div className="min-h-0 flex-1">
          <StartConversation
            onStarted={(id, projectId) => {
              const s = projectsQ.data?.find((p) => p.id === projectId)?.slug;
              if (s) go(chatPath(s, id));
            }}
          />
        </div>
        {mobileList}
      </div>
    );
  }

  if (projectsQ.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <ProjectLoader label="loading chat…" />
      </div>
    );
  }
  if (projectsQ.isError) {
    return (
      <div className="grid h-full place-items-center px-4">
        <ErrorState
          title="Projects could not be read"
          message={formatApiError(projectsQ.error)}
          onRetry={() => projectsQ.refetch()}
        />
      </div>
    );
  }
  const project = projectsQ.data?.find((p) => p.slug === slug);
  if (!project) {
    return (
      <div className="grid h-full place-items-center px-4">
        <ErrorState title="Project not found" message={`No project "${slug}" you can open a chat in.`} />
      </div>
    );
  }

  const draft = conversationId ? undefined : aboutDraft(new URLSearchParams(search).get("about"));
  const panel = <ContextPanel conversationId={conversationId} said={said} slug={project.slug} />;

  return (
    <div className="flex h-full min-h-0">
      <RoomSub projectId={project.id} />
      <div className="min-h-0 min-w-0 flex-1 bg-app">
        <ConversationChat
          key={`${mountKey}:${draft ?? ""}`}
          projectId={project.id}
          conversationId={conversationId ?? undefined}
          initialDraft={draft}
          scopeChip={<ScopeChip name={project.name} />}
          onConversationActive={(id) => {
            adopt(id);
            router.replace(chatPath(project.slug, id));
          }}
          headerActions={
            <>
              {listButton}
              <IconButton
                icon="panelLeft"
                size="sm"
                aria-label="Context"
                className="rotate-180 lg:hidden"
                onClick={() => setContextOpen(true)}
              />
            </>
          }
        />
      </div>
      <aside className="hidden w-80 flex-none border-l border-line bg-surface lg:block" aria-label="Context">
        {panel}
      </aside>
      <SlideOver open={contextOpen} onClose={() => setContextOpen(false)} hideHeader fitBody width="min(92vw, 360px)">
        {panel}
      </SlideOver>
      {mobileList}
    </div>
  );
}
