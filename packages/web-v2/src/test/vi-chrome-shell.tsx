import { say } from "./said";
import { fireEvent } from "@testing-library/react";
import type { QueryKey } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { BottomTabBar, CommandPalette, TopBarSlotProvider } from "@/design";
import { MobileNavDrawer, bottomTabItems, buildWorkspaceCommands } from "@/features/shell";
import { DrawerAccount } from "@/features/shell/components/drawer-account";
import { ProjectSwitcher } from "@/features/shell/components/project-switcher";
import { ShellTopBar } from "@/features/shell/components/shell-top-bar";
import { SidebarBell } from "@/features/shell/components/sidebar-bell";
import { SidebarSearch } from "@/features/shell/components/sidebar-search";
import { WorkspaceSidebar } from "@/features/shell/components/workspace-sidebar";
import { NotFoundBody } from "@/features/shell/components/not-found-body";
import { ChatDockBody } from "@/features/conversations/components/chat-dock";
import { ConversationList } from "@/features/conversations/components/conversation-list";
import type { ChatDockApi } from "@/features/chat-dock/dock";
import { useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { Seeded } from "./vi-chrome-requirements";

// The shell every BA screen sits in, for the vi walking test: the rail in both widths, the project
// switcher, the account menu, the phone drawer and tab bar, the command palette, the top bar, the Ask
// Agent panel and the page-not-found body. The bell and Account preferences are in vi-chrome-account,
// the pieces the screen lanes share in vi-chrome-shared. Content is placeholder words.

const P = "p1";
const AT = "2026-10-07T10:00:00Z";
const project = { id: P, slug: "hop", name: "Hop", role: "admin", orgId: null };
const glyph = { tint: "var(--cobalt-50)", ink: "var(--cobalt-700)" };
const switcher = [
  { id: P, slug: "hop", name: "Hop", initials: "HO", ...glyph, liveRuns: 3, pinned: true },
  { id: "p2", slug: "epod", name: "Epod", initials: "EP", ...glyph, liveRuns: 0, pinned: false },
];
const rail = { projectMark: { name: "Hop", initials: "HO", ...glyph, liveRuns: 3 }, switcherProjects: switcher, togglePin: () => {} };
const needsYou = {
  generatedAt: AT,
  areas: {
    requirements: { you: 2, acts: [{ act: "accept r2", count: 2, says: { act: say("standing.act.acceptR", { r: 2 }) } }] },
    releases: { you: 1, acts: [{ act: "Approve release 0.1.0", count: 1, says: { act: say("standing.act.approveReleaseV", { v: "0.1.0" }) } }] },
    feedback: { you: 0, acts: [] },
    issues: { you: 0, acts: [] },
    contracts: { you: 0, acts: [] },
    automation: { you: 0, acts: [] },
    designs: { you: 1, acts: [{ act: "approve design Kho", count: 1, says: { act: say("standing.act.approveDesign", { what: "Kho" }) } }] },
  },
  items: [],
  requirementsInDelivery: 1,
  untriagedFeedback: 0,
};
const noop = () => {};

function Sidebar({ compact }: { compact: boolean }) {
  return (
    <WorkspaceSidebar
      collapsed={compact}
      onToggleCollapsed={noop}
      groupOpen={{}}
      onToggleGroup={noop}
      activeKey="proj-feedback"
      attentionCount={3}
      railSlug="hop"
      rail={rail as never}
      badges={{ needsYou: needsYou as never }}
      onNavigate={noop}
      onRoute={noop}
      onSignOut={noop}
      userInitials="OR"
      search={(variant) => <SidebarSearch onOpen={noop} compact={variant === "compact"} icon={variant === "icon"} />}
      bell={<SidebarBell count={3} onToggle={noop} />}
    />
  );
}

const railScreen = (compact: boolean) => () => (
  <Seeded data={[[["projects"], [project]]]}>
    <Sidebar compact={compact} />
  </Seeded>
);

const click = (selector: string) => () => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`nothing to open at ${selector}`);
  fireEvent.click(el);
};

const drawer = () => (
  <Seeded data={[[["projects"], [project]]]}>
    <MobileNavDrawer
      open
      onClose={noop}
      slug="hop"
      railSlug="hop"
      railProjectName="Hop"
      activeKey="proj-feedback"
      attentionCount={3}
      badges={{ needsYou: needsYou as never }}
      scopedProjects={[project as never]}
      onNavigate={noop}
      onOpenProject={noop}
      onCreateProject={noop}
      onViewAllProjects={noop}
      search={<SidebarSearch onOpen={noop} />}
      bell={<SidebarBell count={0} onToggle={noop} />}
      footer={<DrawerAccount onAccount={noop} onSignOut={noop} />}
    />
    <MobileNavDrawer
      open
      onClose={noop}
      slug={null}
      railSlug={null}
      railProjectName={null}
      activeKey="overview"
      attentionCount={0}
      badges={{}}
      scopedProjects={[]}
      onNavigate={noop}
      onOpenProject={noop}
      onCreateProject={noop}
      onViewAllProjects={noop}
    />
  </Seeded>
);

function TabBar() {
  const language = useInterfaceLanguage();
  return <BottomTabBar items={bottomTabItems(language === "vi" ? 3 : 0)} activeKey="home" onSelect={noop} />;
}

function Palette() {
  const language = useInterfaceLanguage();
  const commands = buildWorkspaceCommands({
    router: { push: noop },
    slug: "hop",
    activeProjectName: "Hop",
    scopedProjects: [project as never],
    pinnedIds: new Set([P]),
    pinnedViews: [{ href: "/projects/hop/issues?view=x", label: "Bo loc", icon: "list" } as never],
    recents: [{ href: "/projects/hop/requirements/REQ-1", label: "REQ-1", icon: "book", kind: "requirement" } as never],
    toast: noop,
    onNewChat: noop,
  }, language);
  return <CommandPalette open onClose={noop} commands={commands} />;
}

const dock = (target: ChatDockApi["target"]): ChatDockApi => ({
  projectId: P,
  open: true,
  pinned: false,
  setPinned: noop,
  target,
  generation: 0,
  width: 420,
  setWidth: noop,
  show: noop,
  close: noop,
  toggle: noop,
  select: noop,
  follow: noop,
  askAbout: noop,
  setDoor: noop,
});

const room = (id: string, title: string | null, threadStatus: string | null, over: Record<string, unknown> = {}) => ({
  id,
  adapter: "web",
  externalId: id,
  shape: "direct",
  mode: "assistant",
  title,
  updatedAt: AT,
  archivedAt: null,
  ecosystemId: null,
  kind: null,
  threadStatus,
  subjectKey: null,
  projectId: P,
  pinned: false,
  ...over,
});
const rooms = [room("c1", "Hoi ve kho", "waiting_on_you"), room("c2", null, "done", { subjectKey: "REQ-1" }), room("c3", "Viec khac", null, { pinned: true })];
const dockSeed = (): [QueryKey, unknown][] => [
  [["projects"], [project]],
  [["conversations", "list", P, "live"], { items: rooms, total: rooms.length }],
  [["conversations", "c1"], { ...rooms[0], messages: [], windows: [], agentTurns: [] }],
];

const askAgent = () => (
  <Seeded data={dockSeed()}>
    <TopBarSlotProvider>
      <ShellTopBar chatOpen={false} onToggleChat={noop} />
    </TopBarSlotProvider>
    <ChatDockBody dock={dock(null)} />
    <ChatDockBody dock={dock({ kind: "latest", projectId: P })} fullScreen />
  </Seeded>
);

const conversations = () => (
  <Seeded data={dockSeed()}>
    <ConversationList projectId={P} conversationId="c1" pageKey="REQ-1" onSelect={noop} />
  </Seeded>
);

export interface ShellScreen {
  name: string;
  render: () => ReactElement;
  /** What the screen opens after it renders (a menu, a popover), so its chrome is read too. */
  act?: () => void;
}

export const SCREENS: ShellScreen[] = [
  { name: "Navigation rail · labelled", render: railScreen(false) },
  { name: "Navigation rail · compact", render: railScreen(true) },
  { name: "Account menu", render: railScreen(false), act: click('[aria-haspopup="menu"]') },
  {
    name: "Project switcher",
    render: () => (
      <ProjectSwitcher compact={false} project={rail.projectMark} projects={switcher} activeSlug="hop" onSelect={noop} onSettings={noop} onTogglePin={noop} onAllProjects={noop} onNewProject={noop} />
    ),
    act: click('[aria-haspopup="dialog"]'),
  },
  {
    name: "Project switcher · no project",
    render: () => <ProjectSwitcher compact project={null} projects={[]} activeSlug={null} onSelect={noop} onSettings={noop} onTogglePin={noop} onAllProjects={noop} onNewProject={noop} />,
  },
  { name: "Phone navigation drawer", render: drawer },
  { name: "Phone tab bar", render: () => <TabBar /> },
  { name: "Command palette", render: () => <Palette /> },
  { name: "Ask Agent", render: askAgent },
  { name: "Ask Agent · conversations", render: conversations },
  { name: "Page not found", render: () => <NotFoundBody /> },
];
