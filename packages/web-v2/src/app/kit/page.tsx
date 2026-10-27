"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Avatar, Badge, Banner, BoardRowSkeleton, Breadcrumb, Button, Card, CardContent,
  CardHeader, CardTitle, Checkbox, Collapsible, CommandPalette, DataTable, Divider, EmptyState,
  ErrorState, Field, Highlight, HealthDot, Icon, IconButton, Input,
  Kicker, LiveDot, Menu,
  MonoTag, NavRail, NotificationsMenu, Pagination, ProgressBar,
  NativeSelect, ProjectCardSkeleton, ProjectMark, Radio, RadioGroup,
  SegmentedControl, Select, SessionRowSkeleton, Skeleton, SlideOver, Spinner,
  Stat, StatusChip,
  StreamingText, Table, TBody, TD, TH, THead, TR, Tabs, Textarea, Toggle, Tooltip,
  TopBar, HelpButton, PinnedTabBar, VirtualList, useAnimatedNumber, useElapsed,
  type Command, type DataTableColumn, type NotificationItem, type PinnedTab,
  type StatusKey, type TopBarDensity,
} from "@/design";
import {
  ForgeMascot, ProjectLoader, ColdBoot, AgentWorking, ReconnectingBanner,
} from "@/design";
import {
  NavRailCompact, PROJECT_ITEMS, WORKSPACE_ITEMS,
  type RailItem, type SwitcherProject,
} from "@/features/shell";
import { useToast } from "@/providers/toast-provider";
import { PageTitle, SectionTitle } from "@/design/primitives/heading";

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-4">
        <Kicker>{id}</Kicker>
        <SectionTitle className="mt-1">{title}</SectionTitle>
        {hint && <p className="fg-body-sm mt-1 max-w-2xl">{hint}</p>}
      </div>
      <div className="rounded-lg border border-line bg-surface p-6 shadow-sm">{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

const SEMANTIC_TOKENS = [
  ["var(--bg-app)", "App"], ["var(--bg-surface)", "Surface"], ["var(--bg-sunken)", "Sunken"],
  ["var(--bg-hover)", "Hover"], ["var(--border-default)", "Border"], ["var(--fg-default)", "FG"],
  ["var(--fg-muted)", "Muted"], ["var(--accent)", "Accent"], ["var(--link)", "Link"],
];

const STATUSES: StatusKey[] = ["running", "queued", "blocked", "waiting", "passed", "failed", "paused", "done", "review"];

// The shipped nav, straight from the shared model (features/shell/nav-model —
// the same lists src/app/(workspace)/layout.tsx renders), so the kit documents
// what actually ships, not a hypothetical grouping. Demo badges are stubbed
// onto the rows the real shell badges (Overview = attention count, Issues =
// open-issue count).
const WORKSPACE_NAV: RailItem[] = WORKSPACE_ITEMS.map(({ key, label, icon }) => ({
  key, label, icon, ...(key === "overview" ? { badge: 3 } : {}),
}));

const PROJECT_NAV: RailItem[] = PROJECT_ITEMS.map(({ key, label, icon }) => ({
  key, label, icon, ...(key === "proj-issues" ? { badge: 12 } : {}),
}));

const RAIL_SWITCHER: SwitcherProject[] = [
  { id: "p1", slug: "forge-core", name: "forge-core", initials: "FRG", tint: "var(--flame-50)", ink: "var(--flame-700)", liveSessions: 3, liveSessionsRead: "read", pinned: true },
  { id: "p2", slug: "forge-web", name: "forge-web", initials: "FWB", tint: "var(--cobalt-50)", ink: "var(--cobalt-700)", liveSessions: 1, liveSessionsRead: "read", pinned: true },
  { id: "p3", slug: "data-pipeline", name: "data-pipeline", initials: "DP", tint: "var(--green-50)", ink: "var(--green-600)", liveSessions: 0, liveSessionsRead: "read", pinned: false },
];

const COMMANDS: Command[] = [
  { label: "FRG-238 · Review changes", icon: "clock", group: "recent" },
  { label: "forge-core", icon: "pin", group: "pinned", keywords: "project" },
  { label: "Issues · active", icon: "list", group: "pinned", keywords: "view" },
  { label: "Go to Pipeline", icon: "pipeline", kbd: "G P", group: "navigate" },
  { label: "Go to Conversations", icon: "inbox", kbd: "G E", group: "navigate" },
  { label: "All projects", icon: "folder", kbd: "G O", group: "navigate" },
  { label: "Create issue", icon: "plus", kbd: "C", group: "actions" },
  { label: "Pair a device", icon: "server", group: "actions" },
  { label: "Cancel a run", icon: "stop", group: "actions" },
];

const NOTES: NotificationItem[] = [
  { id: "FRG-238", label: "STATUS", text: "Review agent requested changes", sub: "missing index migration", time: "4m", unread: true, hue: "amber" },
  { id: "FRG-224", label: "WEDGE", text: "Pipeline blocked on PM policy", sub: "prod deploy needs approval", time: "22m", unread: true, hue: "red" },
  { id: "FRG-230", label: "STATUS", text: "Release agent opened PR #1284", sub: "ready to merge", time: "1h", unread: false, hue: "green" },
];

const NAV_ANCHORS = [
  "tokens", "type", "buttons", "status", "avatars", "tags", "forms", "cards",
  "navrail", "topbar", "shell", "overlays", "states",
  "mascot", "skeletons", "progress", "feedback", "realtime",
  "formcontrols", "display", "disclosure", "data", "datatable", "virtuallist", "overlays2", "pageload",
];

function MascotProgressDemo() {
  const [p, setP] = useState(0.35);
  return (
    <div className="flex flex-col items-center gap-4">
      <ForgeMascot size={150} mode="both" ring progress={p} flicker />
      <input
        type="range" min={0} max={100} value={p * 100}
        onChange={(e) => setP(Number(e.target.value) / 100)}
        className="w-56 accent-[var(--accent)]" aria-label="Pipeline progress"
      />
      <span className="fg-caption font-mono">progress {Math.round(p * 100)}% · eyes track + ring follows</span>
    </div>
  );
}

function ProjectLoaderDemo() {
  const phases = ["connecting to runners…", "syncing pipeline state…", "loading 142 issues…", "4 / 4 streams live"];
  const [p, setP] = useState(0);
  useEffect(() => {
    if (p >= phases.length - 1) return;
    const t = setTimeout(() => setP(p + 1), 1300);
    return () => clearTimeout(t);
  }, [p, phases.length]);
  const done = p === phases.length - 1;
  return <ProjectLoader label={phases[p]} progress={(p + 0.5) / phases.length} done={done} />;
}

function AgentWorkingDemo() {
  const [start] = useState(() => Date.now());
  const elapsed = useElapsed(start, true);
  return <AgentWorking label={<><b>Code agent</b> is working…</>} elapsed={elapsed} />;
}

/* ── interactive demos for the loading & motion sections ── */

function LoadingButtonDemo() {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      variant="primary"
      icon="play"
      loading={loading}
      onClick={() => {
        setLoading(true);
        setTimeout(() => setLoading(false), 1800);
      }}
    >
      Run pipeline
    </Button>
  );
}

function ProgressDemo() {
  const [value, setValue] = useState(40);
  return (
    <div className="flex max-w-md flex-col gap-3">
      <ProgressBar value={value} />
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
        aria-label="Progress value"
      />
      <span className="fg-caption">Indeterminate (unknown %):</span>
      <ProgressBar indeterminate />
    </div>
  );
}

function StreamingDemo() {
  const full =
    "On it. Detecting jobs left in `running` whose runner just reconnected, then sweeping them after a 30s grace window so we don't race an in-flight heartbeat.";
  const [n, setN] = useState(0);
  const done = n >= full.length;
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setN((x) => Math.min(full.length, x + 2)), 24);
    return () => clearInterval(id);
  }, [done, full.length]);
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <StreamingText text={full.slice(0, n)} streaming={!done} />
      <Button size="sm" variant="ghost" icon="rerun" onClick={() => setN(0)}>
        Replay
      </Button>
    </div>
  );
}

function ElapsedDemo() {
  const [start, setStart] = useState<number | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const elapsed = useElapsed(start, running);
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-fg" style={{ fontSize: "var(--text-15)", minWidth: 64 }}>{elapsed}</span>
      <Button
        size="sm"
        variant={running ? "danger" : "secondary"}
        icon={running ? "stop" : "play"}
        onClick={() => {
          if (running) setRunning(false);
          else {
            setStart(Date.now());
            setRunning(true);
          }
        }}
      >
        {running ? "Stop" : "Start run"}
      </Button>
    </div>
  );
}

function AnimatedStatDemo() {
  const [n, setN] = useState(142);
  const display = useAnimatedNumber(n);
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-fg" style={{ fontSize: "var(--text-22)", fontWeight: 700, minWidth: 72 }}>
        {Math.round(display)}
      </span>
      <span className="fg-caption">tests passed</span>
      <Button size="sm" variant="secondary" icon="plus" onClick={() => setN((x) => x + 37)}>
        +37
      </Button>
    </div>
  );
}

function HighlightDemo() {
  const [tick, setTick] = useState(0);
  const [stage, setStage] = useState("implement");
  const [status, setStatus] = useState<StatusKey>("running");
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <Highlight trigger={tick} className="rounded-md border border-line bg-surface px-3 py-2.5">
        <div className="flex items-center gap-3">
          <MonoTag>FRG-241</MonoTag>
          <span className="fg-body-sm flex-1 truncate text-fg">Sweep orphaned runner jobs on reconnect</span>
          <StatusChip status={status} stage={stage} size="sm" />
        </div>
      </Highlight>
      <Button
        size="sm"
        variant="secondary"
        icon="activity"
        onClick={() => {
          setStatus("passed");
          setStage("review");
          setTick((t) => t + 1);
        }}
      >
        Simulate WS update
      </Button>
    </div>
  );
}

function ToastButtons() {
  const { toast } = useToast();
  return (
    <div className="flex flex-wrap gap-3">
      <Button size="sm" variant="primary" icon="plus" onClick={() => toast({ title: "Issue created", description: "FRG-242 · routed to triage", tone: "success" })}>
        Create issue
      </Button>
      <Button size="sm" variant="secondary" icon="trash" onClick={() => toast({ title: "Ended 1 silent session.", tone: "info" })}>
        End silent sessions
      </Button>
      <Button size="sm" variant="danger" icon="alert" onClick={() => toast({ title: "Runner lost connection", description: "ci-runner-01 — retrying", tone: "error" })}>
        Trigger error
      </Button>
    </div>
  );
}

const MODEL_OPTS = [
  { value: "haiku", label: "claude-haiku", icon: "cpu" as const },
  { value: "sonnet", label: "claude-sonnet", icon: "agent" as const },
  { value: "opus", label: "claude-opus", icon: "star" as const },
  { value: "legacy", label: "claude-2 (retired)", icon: "archive" as const, disabled: true },
];

function FormControlsDemo() {
  const [check, setCheck] = useState(true);
  const [model, setModel] = useState("sonnet");
  const [nativeModel, setNativeModel] = useState("sonnet");
  const [sort, setSort] = useState("recent");
  const [title, setTitle] = useState("");
  const titleError = title.trim().length > 0 && title.trim().length < 4 ? "Title needs at least 4 characters." : undefined;

  return (
    <div className="grid max-w-xl gap-5">
      <Field label="Issue title" required error={titleError} hint="A short, action-first summary.">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sweep orphaned runner jobs" />
      </Field>
      <Field label="Model" hint="Custom accessible listbox — ↑/↓, type-ahead, Enter.">
        <Select options={MODEL_OPTS} value={model} onChange={setModel} />
      </Field>
      <Field label="Model (native)" hint="OS-native picker fallback.">
        <NativeSelect
          options={MODEL_OPTS}
          value={nativeModel}
          onChange={(e) => setNativeModel(e.target.value)}
        />
      </Field>
      <Field label="Notes" htmlFor="kit-notes">
        <Textarea id="kit-notes" placeholder="Anything the agent should know…" />
      </Field>
      <Checkbox checked={check} onChange={setCheck} label="Auto-advance on pass" />
      <div>
        <span className="fg-label mb-2 block">Sort</span>
        <RadioGroup name="kit-sort" value={sort} onChange={setSort}>
          <Radio value="recent" label="Most recent" />
          <Radio value="name" label="Name" />
          <Radio value="health" label="Health" />
        </RadioGroup>
      </div>
    </div>
  );
}

function TabsDemo() {
  const [tab, setTab] = useState("activity");
  return (
    <div>
      <Tabs
        tabs={[
          { value: "activity", label: "Activity" },
          { value: "tasks", label: "Tasks", count: 5 },
          { value: "comments", label: "Comments", count: 3 },
        ]}
        value={tab}
        onChange={setTab}
      />
      <p className="fg-body-sm mt-3 capitalize">{tab} panel</p>
    </div>
  );
}

const DEMO_SESSIONS = [
  { sid: "S-1043", iss: "FRG-241", st: "running" as StatusKey, cost: 0.42 },
  { sid: "S-1042", iss: "FRG-238", st: "review" as StatusKey, cost: 1.08 },
  { sid: "S-1039", iss: "FRG-224", st: "failed" as StatusKey, cost: 0.91 },
  { sid: "S-1031", iss: "FRG-219", st: "done" as StatusKey, cost: 2.4 },
  { sid: "S-1027", iss: "FRG-241", st: "failed" as StatusKey, cost: 0.17 },
];

type DemoSession = (typeof DEMO_SESSIONS)[number];

const DEMO_COLUMNS: DataTableColumn<DemoSession>[] = [
  { id: "session", header: "session", cell: (r) => <MonoTag>{r.sid}</MonoTag>, sortValue: (r) => r.sid, searchText: (r) => r.sid },
  { id: "issue", header: "issue", cell: (r) => <MonoTag hue="cobalt">{r.iss}</MonoTag>, sortValue: (r) => r.iss, searchText: (r) => r.iss },
  { id: "status", header: "status", cell: (r) => <StatusChip status={r.st} size="sm" />, filterValue: (r) => r.st },
  { id: "cost", header: "cost", align: "end", firstSort: "desc", cell: (r) => <span className="font-mono">${r.cost.toFixed(2)}</span>, sortValue: (r) => r.cost },
];

function DataTableDemo() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <Row>
        <Input
          icon="search"
          className="min-w-[200px] max-w-[320px] flex-1"
          placeholder="Search sessions…"
          aria-label="Search sessions"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          className="w-[160px]"
          aria-label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: "Any status" },
            { value: "failed", label: "Failed" },
            { value: "running", label: "Running" },
            { value: "done", label: "Done" },
          ]}
        />
      </Row>
      <DataTable
        aria-label="Sessions"
        rows={DEMO_SESSIONS}
        columns={DEMO_COLUMNS}
        getRowId={(r) => r.sid}
        defaultSort={{ id: "cost", desc: true }}
        search={search}
        filters={{ status }}
        empty="No session matches."
      />
    </div>
  );
}

const LONG_SESSIONS = Array.from({ length: 300 }, (_, i) => ({ sid: `S-${2000 + i}`, iss: `FRG-${300 + i}` }));

const LONG_COLUMNS: DataTableColumn<(typeof LONG_SESSIONS)[number]>[] = [
  { id: "session", header: "session", sticky: true, cell: (r) => <MonoTag>{r.sid}</MonoTag>, sortValue: (r) => r.sid },
  { id: "issue", header: "issue", cell: (r) => <MonoTag hue="cobalt">{r.iss}</MonoTag> },
  { id: "actions", header: null, headerLabel: "Actions", align: "end", cell: (r) => <Button size="sm" variant="secondary">{`Open ${r.sid}`}</Button> },
];

// 300 rows, so past 100 the table draws only the rows in view and scrolls inside its own frame.
function LongTableDemo() {
  return <DataTable aria-label="Three hundred sessions" rows={LONG_SESSIONS} columns={LONG_COLUMNS} getRowId={(r) => r.sid} />;
}

const DEMO_WORKSPACES = [
  { slug: "forge-core", runs: 38, spend: 41.2 },
  { slug: "forge-web", runs: 21, spend: 63.9 },
  { slug: "data-pipeline", runs: 9, spend: 12.4 },
];

const RANKINGS = {
  runs: (a: (typeof DEMO_WORKSPACES)[number], b: (typeof DEMO_WORKSPACES)[number]) => b.runs - a.runs,
  spend: (a: (typeof DEMO_WORKSPACES)[number], b: (typeof DEMO_WORKSPACES)[number]) => b.spend - a.spend,
};

const RANKED_COLUMNS: DataTableColumn<(typeof DEMO_WORKSPACES)[number]>[] = [
  { id: "workspace", header: "workspace", cell: (r) => <MonoTag>{r.slug}</MonoTag> },
  { id: "runs", header: "runs", align: "end", firstSort: "desc", sortDirections: ["desc"], sortValue: (r) => r.runs, cell: (r) => <span className="font-mono">{r.runs}</span> },
  { id: "spend", header: "spend", align: "end", firstSort: "desc", sortDirections: ["desc"], sortValue: (r) => r.spend, cell: (r) => <span className="font-mono">${r.spend.toFixed(2)}</span> },
];

// A ranking the server answers, as the operator overview's is: the table reports which header was
// pressed and shows the rows in the order that answer arrives, largest first and never ascending.
function RankedDemo() {
  const [by, setBy] = useState<"runs" | "spend">("runs");
  const ranked = [...DEMO_WORKSPACES].sort(RANKINGS[by]);
  return (
    <DataTable
      aria-label="Ranked workspaces"
      rows={ranked}
      columns={RANKED_COLUMNS}
      getRowId={(r) => r.slug}
      sort={{ id: by, desc: true }}
      onSortChange={(s) => setBy(s.id === "spend" ? "spend" : "runs")}
      manualSort
    />
  );
}

const LONG_LIST = Array.from({ length: 1300 }, (_, i) => ({ id: `n${i + 1}`, title: `Notification ${i + 1}` }));

// 1,300 rows, of which the document holds only those in view: PageDown and PageUp walk row to row.
function VirtualListDemo() {
  return (
    <VirtualList
      aria-label="Notifications, 1,300 of them"
      rows={LONG_LIST}
      getRowId={(r) => r.id}
      getRowLabel={(r) => r.title}
      estimateRowHeight={44}
      renderRow={(r) => <p className="fg-body-sm px-1 py-3 text-fg">{r.title}</p>}
    />
  );
}

function PaginationDemo() {
  const [page, setPage] = useState(2);
  return <Pagination page={page} pageCount={7} onChange={setPage} />;
}

function SlideOverDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" icon="arrowRight" onClick={() => setOpen(true)}>
        Open run detail
      </Button>
      <SlideOver open={open} onClose={() => setOpen(false)} title={<span className="font-mono">FRG-241</span>}>
        <p className="fg-body-sm mt-5">Sweep orphaned runner jobs on reconnect. Code agent is editing the reconnect handler.</p>
      </SlideOver>
    </>
  );
}

export default function KitPage() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(true);
  const [toggleOn, setToggleOn] = useState(true);
  const [view, setView] = useState<"cards" | "list">("cards");
  const [navActive, setNavActive] = useState("proj-issues");
  // Shell demos: density toggle (TopBar) + pinned tabs.
  const [kitDensity, setKitDensity] = useState<TopBarDensity>("comfortable");
  const [kitTabs, setKitTabs] = useState<PinnedTab[]>([
    { id: "issues-active", label: "Issues · active", icon: "list", href: "/projects/forge-core/issues?filter=active" },
    { id: "pipeline", label: "Pipeline", icon: "pipeline", href: "/projects/forge-core/pipeline" },
  ]);
  const [kitActiveTab, setKitActiveTab] = useState("/projects/forge-core/issues?filter=active");

  return (
    <div className="min-h-screen bg-app">
      <div className="mx-auto flex max-w-[1180px] gap-8 px-6 py-10">
        {/* in-page nav */}
        <aside className="sticky top-10 hidden h-fit w-40 flex-none lg:block">
          <Kicker>Kit</Kicker>
          <ul className="mt-2 flex flex-col gap-0.5">
            {NAV_ANCHORS.map((a) => (
              <li key={a}>
                <a href={`#${a}`} className="fg-body-sm block rounded-sm px-2 py-1 capitalize text-muted hover:bg-hover hover:text-fg">
                  {a}
                </a>
              </li>
            ))}
          </ul>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-10">
          <header>
            <div className="flex items-center gap-2.5">
              <span className="inline-flex size-9 items-center justify-center rounded-lg" style={{ background: "var(--flame-500)", color: "var(--fg-on-accent)" }}>
                <Icon name="pipeline" size={20} strokeWidth={2} />
              </span>
              <div>
                <PageTitle>Forge — Web v2 kit</PageTitle>
                <p className="fg-body-sm">Design layer preview · light theme · Hanken Grotesk + JetBrains Mono</p>
              </div>
            </div>
          </header>

          <Section id="tokens" title="Color tokens" hint="Semantic layer (components reference these).">
            <Row>
              {SEMANTIC_TOKENS.map(([ink, label]) => (
                <div key={ink} className="flex flex-col items-center gap-1.5">
                  <span className="size-14 rounded-md border border-line" style={{ background: ink }} />
                  <span className="fg-caption">{label}</span>
                  <span className="font-mono text-10 text-subtle">{ink.slice(4, -1)}</span>
                </div>
              ))}
            </Row>
          </Section>

          <Section id="type" title="Typography">
            <div className="flex flex-col gap-2">
              <p className="fg-display">Display 44</p>
              <p className="fg-h1">Heading 1</p>
              <p className="fg-h2">Heading 2</p>
              <p className="fg-h3">Heading 3</p>
              <p className="fg-body">Body — a calm humanist grotesk at 15px / 1.55 for comfortable reading.</p>
              <p className="fg-body-sm">Body small — secondary copy and table cells.</p>
              <p className="fg-label">Label 13 / 600</p>
              <p className="fg-caption">Caption 12 — captions and timestamps.</p>
              <p className="fg-overline">Overline · section kicker</p>
              <p className="fg-mono">mono 13 — IDs, metrics, $0.42, 12s median</p>
              <p><code className="fg-code">GET /api/issues/:id</code></p>
            </div>
          </Section>

          <Section id="buttons" title="Buttons" hint="Flame is reserved for the primary action. Secondary, ghost, danger stay neutral.">
            <div className="flex flex-col gap-4">
              <Row>
                <Button variant="primary" icon="play">Run pipeline</Button>
                <Button variant="secondary" icon="pause">Pause run</Button>
                <Button variant="ghost" icon="rerun">Rerun</Button>
                <Button variant="danger" icon="trash">Cancel</Button>
                <Button variant="primary" disabled>Disabled</Button>
              </Row>
              <Row>
                <Button size="sm" variant="primary" icon="plus">New issue</Button>
                <Button size="sm" variant="secondary" icon="fork">Fork</Button>
                <Button size="sm" variant="ghost" icon="more" />
              </Row>
            </div>
          </Section>

          <Section id="status" title="Status & health" hint="Two domains: issue lifecycle (pill, dot) vs agent/session execution (squared, agent glyph). Running pulses and shows the step it is on.">
            <div className="flex flex-col gap-4">
              <Row>
                {STATUSES.map((s) => (
                  <StatusChip key={s} status={s} stage={s === "running" ? "implement" : undefined} />
                ))}
              </Row>
              <Row>
                {STATUSES.map((s) => (
                  <StatusChip key={s} status={s} stage={s === "running" ? "implement" : undefined} domain="session" />
                ))}
              </Row>
              <Row>
                <HealthDot health="healthy" />
                <HealthDot health="attention" />
                <HealthDot health="down" />
                <HealthDot health="idle" />
              </Row>
            </div>
          </Section>

          <Section id="avatars" title="Avatars & marks">
            <Row>
              <Avatar initials="SK" hue="cobalt" />
              <Avatar initials="AR" hue="flame" />
              <Avatar initials="MJ" hue="green" />
              <Avatar initials="DP" hue="amber" size={32} />
              <ProjectMark tint="var(--flame-50)" ink="var(--flame-700)" initials="FRG" />
              <ProjectMark tint="var(--cobalt-50)" ink="var(--cobalt-700)" initials="FWB" />
              <ProjectMark tint="var(--green-50)" ink="var(--green-600)" initials="FCT" />
            </Row>
          </Section>

          <Section id="tags" title="Mono tags & stats">
            <Row>
              <MonoTag>FRG-241</MonoTag>
              <MonoTag hue="cobalt">main</MonoTag>
              <MonoTag hue="flame">claude-opus</MonoTag>
              <span className="mx-2 h-5 w-px bg-[var(--border-default)]" />
              <Stat icon="dollar">$0.42</Stat>
              <Stat icon="clock">12s median</Stat>
              <Stat icon="branch">4 / 7 steps</Stat>
            </Row>
          </Section>

          <Section id="forms" title="Forms">
            <div className="grid max-w-xl gap-5">
              <Field label="Project name" htmlFor="kit-project" hint="Sentence case, never New Project.">
                <Input id="kit-project" placeholder="forge-core" />
              </Field>
              <Field label="Search" htmlFor="kit-search">
                <Input id="kit-search" icon="search" placeholder="Search or jump to…" />
              </Field>
              <div className="flex items-center gap-8">
                <label className="flex items-center gap-3">
                  <Toggle checked={toggleOn} onChange={setToggleOn} aria-label="Enabled" />
                  <span className="fg-body-sm text-fg">Schedule enabled</span>
                </label>
                <SegmentedControl
                  options={[
                    { value: "cards", label: "Cards", icon: "grid" },
                    { value: "list", label: "List", icon: "rows" },
                  ]}
                  value={view}
                  onChange={setView}
                />
              </div>
            </div>
          </Section>

          <Section id="cards" title="Cards">
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>forge-core</CardTitle>
                  <HealthDot health="attention" />
                </CardHeader>
                <CardContent>
                  <p className="fg-body-sm">Hono backend, runner & MCP server on Postgres.</p>
                  <div className="mt-3 flex gap-4">
                    <Stat icon="activity">3 runs</Stat>
                    <Stat icon="inbox">12 open</Stat>
                    <Stat icon="dollar">$5.81</Stat>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>forge-web</CardTitle>
                  <HealthDot health="healthy" />
                </CardHeader>
                <CardContent>
                  <p className="fg-body-sm">Next.js cloud interface.</p>
                  <div className="mt-3 flex gap-4">
                    <Stat icon="activity">1 run</Stat>
                    <Stat icon="inbox">7 open</Stat>
                    <Stat icon="dollar">$1.20</Stat>
                  </div>
                </CardContent>
              </Card>
            </div>
          </Section>

          <Section id="navrail" title="Nav rail" hint="Concept C, two modes. Default: the compact 88px icon Rail — the workspace tier, a hover project switcher, then the flat project tier (both tiers come from the shared nav model the shell renders). Active row = flame tint + a 3px accent bar; badged rows carry count pills. Brand expands it to the labeled 232px rail.">
            <div className="flex gap-6">
              {/* Default: compact 88px rail. Hover the project mark for the switcher. */}
              <div className="h-[560px] overflow-hidden rounded-md border border-line">
                <NavRailCompact
                  workspaceItems={WORKSPACE_NAV}
                  projectItems={PROJECT_NAV}
                  activeKey={navActive}
                  activeSlug="forge-core"
                  activeProject={{ name: "forge-core", initials: "FRG", tint: "var(--flame-50)", ink: "var(--flame-700)", liveSessions: 3, liveSessionsRead: "read" }}
                  switcherProjects={RAIL_SWITCHER}
                  onNavigate={setNavActive}
                  onSelectProject={() => {}}
                  onTogglePin={() => {}}
                  onAllProjects={() => {}}
                  onNewProject={() => {}}
                  userInitials="SK"
                />
              </div>
              {/* Expanded: the labeled 232px rail (brand toggles between the two). */}
              <div className="h-[560px] flex-1 overflow-hidden rounded-md border border-line">
                <NavRail
                  workspaceItems={WORKSPACE_NAV}
                  projectItems={PROJECT_NAV}
                  activeKey={navActive}
                  onNavigate={setNavActive}
                  onDocs={() => setNavActive("docs")}
                  onProjectSwitch={() => {}}
                  project={{ name: "forge-core", initials: "FRG", tint: "var(--flame-50)", ink: "var(--flame-700)" }}
                  user={{ initials: "SK" }}
                />
              </div>
            </div>
          </Section>

          <Section id="topbar" title="Top bar" hint="Search / ⌘K, density toggle (Comfortable/Compact), notifications, primary action.">
            <div className="overflow-hidden rounded-md border border-line">
              <TopBar
                title="Board"
                notificationCount={2}
                density={kitDensity}
                onDensityChange={setKitDensity}
                onCommandPalette={() => setPaletteOpen(true)}
                onNotifications={() => setNotesOpen((v) => !v)}
              />
            </div>
          </Section>

          <Section id="shell" title="Shell · help, pinned tabs" hint="HelpButton/HelpPopover (what the page does / actions / shortcuts) and the horizontal pinned-view tab bar (route + filter deep-links).">
            <div className="flex flex-col gap-5">
              <Row>
                <HelpButton
                  summary="Reusable contextual help — drop it on any complex surface. Closeable (Esc / click-away / ✕); focus returns to the trigger."
                  actions={["Explain what the page does", "List the primary actions", "Show keyboard shortcuts"]}
                  shortcuts={[
                    { keys: "⌘K", desc: "Command palette" },
                    { keys: "esc", desc: "Close" },
                  ]}
                />
                <span className="fg-body-sm text-muted">← click to open the help popover</span>
              </Row>
              <div className="overflow-hidden rounded-md border border-line">
                <PinnedTabBar
                  tabs={kitTabs}
                  activeHref={kitActiveTab}
                  onSelect={setKitActiveTab}
                  onRemove={(id) => setKitTabs((t) => t.filter((x) => x.id !== id))}
                />
              </div>
            </div>
          </Section>

          <Section id="overlays" title="Command palette & notifications" hint="⌘K palette is arrow-key navigable. Click to open.">
            <div className="flex flex-wrap items-start gap-6">
              <Button variant="secondary" icon="search" onClick={() => setPaletteOpen(true)}>
                Open command palette
              </Button>
              {notesOpen && <NotificationsMenu items={NOTES} />}
            </div>
          </Section>

          <Section id="states" title="Empty & loading states">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-md border border-line">
                <EmptyState title="No issues yet" message="Create one and the triage agent takes it from here." action={{ label: "New issue", icon: "plus" }} />
              </div>
              <div className="flex items-center justify-center gap-3 rounded-md border border-line p-10">
                <Spinner /> <span className="fg-body-sm">Loading runs…</span>
              </div>
            </div>
          </Section>

          <Section id="mascot" title="Mascot" hint="The living Forge mark — blinks, tracks the pipeline progress, flames flicker, breathes. The face of every empty/loading state.">
            <div className="grid items-center gap-8 sm:grid-cols-3">
              <div className="flex flex-col items-center gap-2">
                <ForgeMascot size={120} mode="blink" ring={false} />
                <span className="fg-caption">blink · no ring</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <MascotProgressDemo />
              </div>
              <div className="flex flex-col items-center gap-2">
                <ForgeMascot size={120} mode="blink" ring={false} flicker={false} progress={0.4} />
                <span className="fg-caption">flame stilled (error)</span>
              </div>
            </div>
          </Section>

          <Section id="skeletons" title="Skeletons" hint="Cold-load placeholders that mirror the real layout (warm paper shimmer) — shown instead of a centered spinner.">
            <div className="flex flex-col gap-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <ProjectCardSkeleton />
                <ProjectCardSkeleton />
              </div>
              <div className="rounded-md border border-line bg-surface">
                <BoardRowSkeleton />
                <BoardRowSkeleton />
                <BoardRowSkeleton />
              </div>
              <div className="rounded-md border border-line bg-surface">
                <SessionRowSkeleton />
                <SessionRowSkeleton />
              </div>
              <div className="flex items-center gap-3">
                <Skeleton variant="circle" className="size-9" />
                <Skeleton variant="text" className="w-40" />
                <Skeleton className="h-6 w-20 rounded-pill" />
              </div>
            </div>
          </Section>

          <Section id="progress" title="Progress & busy" hint="Determinate vs indeterminate; inline button loading; the pipeline mini bar now sweeps a flame sliver while running.">
            <div className="flex flex-col gap-6">
              <ProgressDemo />
              <div className="my-1 h-px bg-[var(--border-subtle)]" />
              <div className="flex flex-wrap items-center gap-6">
                <LoadingButtonDemo />
                <div className="flex items-center gap-3">
                  <Spinner /> <Spinner size={22} /> <span className="fg-body-sm">inline spinners</span>
                </div>
              </div>
            </div>
          </Section>

          <Section id="feedback" title="Feedback — error & toasts" hint="Distinct error state with retry; toasts on create / sweep / failure (bottom-right).">
            <div className="flex flex-col gap-6">
              <div className="rounded-md border border-line">
                <ErrorState title="Couldn't load runs" message="Couldn't load runs. Check your connection, then retry." error={undefined} onRetry={() => {}} />
              </div>
              <ToastButtons />
            </div>
          </Section>

          <Section id="realtime" title="Real-time motion" hint="The signature layer: live connection, streaming output, change-highlight, ticking durations, count-up.">
            <div className="flex flex-col gap-7">
              <Row>
                <LiveDot state="live" withLabel />
                <LiveDot state="connecting" withLabel />
                <LiveDot state="offline" withLabel />
              </Row>
              <div className="flex flex-col gap-3 sm:max-w-md">
                <span className="fg-caption block">Agent working (mascot) · reconnecting</span>
                <AgentWorkingDemo />
                <ReconnectingBanner />
              </div>
              <div>
                <span className="fg-caption mb-2 block">Streaming agent output</span>
                <StreamingDemo />
              </div>
              <div>
                <span className="fg-caption mb-2 block">Highlight on WS update</span>
                <HighlightDemo />
              </div>
              <div className="flex flex-wrap items-center gap-10">
                <div>
                  <span className="fg-caption mb-2 block">Live duration</span>
                  <ElapsedDemo />
                </div>
                <div>
                  <span className="fg-caption mb-2 block">Animated stat</span>
                  <AnimatedStatDemo />
                </div>
              </div>
            </div>
          </Section>

          <Section id="formcontrols" title="Form controls" hint="Textarea, Select, Checkbox, Radio — all on the semantic token + focus-ring system.">
            <FormControlsDemo />
          </Section>

          <Section id="display" title="Display" hint="Badges, banners, dividers, tooltips, breadcrumbs, icon buttons, pagination.">
            <div className="flex flex-col gap-6">
              <Row>
                <Badge>12</Badge>
                <Badge tone="accent">3</Badge>
                <Badge tone="cobalt">beta</Badge>
                <Badge tone="green">passed</Badge>
                <Badge tone="red">2 failed</Badge>
                <Badge tone="amber">review</Badge>
              </Row>
              <div className="flex flex-col gap-2.5">
                <Banner tone="attention" action={<Button size="sm" variant="secondary">Review</Button>}>
                  2 projects need attention — a runner is offline and a deploy is blocked.
                </Banner>
                <Banner tone="info">A new agent session started for FRG-241.</Banner>
                <Banner tone="danger">Runner ci-runner-01 lost connection.</Banner>
                <Banner tone="success">Release agent opened PR #1284 → main.</Banner>
              </div>
              <Row>
                <Breadcrumb items={[{ label: "Projects", href: "#" }, { label: "forge-core", href: "#" }, { label: "FRG-241" }]} />
                <Divider orientation="vertical" className="h-5" />
                <Tooltip label="⌘K">
                  <IconButton icon="search" aria-label="Search" />
                </Tooltip>
                <IconButton icon="more" variant="secondary" aria-label="More" />
                <Menu
                  trigger={<IconButton icon="settings" variant="secondary" aria-label="Run actions" />}
                  items={[
                    { label: "Pause run", icon: "pause" },
                    { label: "Rerun", icon: "rerun" },
                    { label: "Fork", icon: "fork" },
                    { label: "Cancel", icon: "trash", danger: true },
                  ]}
                />
                <PaginationDemo />
              </Row>
            </div>
          </Section>

          <Section id="disclosure" title="Tabs & disclosure">
            <div className="flex flex-col gap-6">
              <TabsDemo />
              <Collapsible title="Agent plan — 5 tasks" defaultOpen>
                <ol className="fg-body-sm flex list-decimal flex-col gap-1 pl-5">
                  <li>Detect orphaned jobs on runner reconnect</li>
                  <li>Add grace-period sweep to the job table</li>
                  <li>Emit pipeline event on cleanup</li>
                </ol>
              </Collapsible>
            </div>
          </Section>

          <Section id="data" title="Table" hint="Calm data table — sessions / issues lists.">
            <Table>
              <THead>
                <tr>
                  <TH>session</TH>
                  <TH>issue</TH>
                  <TH>status</TH>
                  <TH className="text-right">cost</TH>
                </tr>
              </THead>
              <TBody>
                {[
                  { sid: "S-1043", iss: "FRG-241", st: "running" as StatusKey, stage: "implement", cost: "$0.42" },
                  { sid: "S-1042", iss: "FRG-238", st: "review" as StatusKey, stage: undefined, cost: "$1.08" },
                  { sid: "S-1039", iss: "FRG-224", st: "failed" as StatusKey, stage: undefined, cost: "$0.91" },
                ].map((r) => (
                  <TR key={r.sid}>
                    <TD><MonoTag>{r.sid}</MonoTag></TD>
                    <TD><MonoTag hue="cobalt">{r.iss}</MonoTag></TD>
                    <TD><StatusChip status={r.st} stage={r.stage} size="sm" /></TD>
                    <TD className="text-right font-mono">{r.cost}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Section>

          <Section id="datatable" title="DataTable" hint="A Table whose headers sort it and whose rows take a search and a filter. The screen owns the controls; the table owns the ordering, unless the rows arrive ranked by the server.">
            <div className="flex flex-col gap-6">
              <DataTableDemo />
              <RankedDemo />
              <LongTableDemo />
            </div>
          </Section>

          <Section id="virtuallist" title="VirtualList" hint="A long list that draws only the rows in view: each row says its place in the whole, and PageDown, PageUp, Ctrl+Home and Ctrl+End move focus between rows. A table of more than 100 rows does the same inside its own frame.">
            <VirtualListDemo />
          </Section>

          <Section id="overlays2" title="Slide-over & menu" hint="Right-hand detail drawer (RunDetail) + dropdown menus.">
            <Row>
              <SlideOverDemo />
            </Row>
          </Section>

          <Section id="pageload" title="Page load & route transitions" hint="Top flame progress bar on navigation, a Suspense skeleton (loading.tsx), and a page enter transition (template.tsx).">
            <div className="flex flex-col gap-4">
              <p className="fg-body-sm">
                Navigate to a real async route — watch the top bar, the loading skeleton, then the page rise-in.
              </p>
              <Row>
                <Link href="/kit/sandbox">
                  <Button variant="primary" icon="arrowRight">Open sandbox route</Button>
                </Link>
                <span className="fg-caption">then use “Back to kit” there</span>
              </Row>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-center justify-center rounded-md border border-line bg-sunken py-10">
                  <ColdBoot />
                </div>
                <div className="flex items-center justify-center rounded-md border border-line bg-sunken py-10">
                  <ProjectLoaderDemo />
                </div>
              </div>
            </div>
          </Section>

          <footer className="fg-caption pb-10 pt-4">
            web-v2 design layer
          </footer>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={COMMANDS} />
    </div>
  );
}
