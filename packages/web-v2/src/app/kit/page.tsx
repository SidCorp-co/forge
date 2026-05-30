"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Avatar, Badge, Banner, BoardRowSkeleton, Breadcrumb, Button, Card, CardContent,
  CardHeader, CardTitle, Checkbox, Collapsible, CommandPalette, Divider, EmptyState,
  ErrorState, Field, Highlight, HealthDot, Icon, IconButton, Input,
  KanbanBoard, KanbanCardSkeleton, KanbanColumn, KanbanColumnSkeleton, Kicker, KanbanCard, LiveDot, Menu,
  MonoTag, NavRail, NotificationsMenu, Pagination, PipelineTracker, ProgressBar,
  NativeSelect, ProjectCardSkeleton, ProjectMark, Radio, RadioGroup,
  SegmentedControl, Select, SessionRowSkeleton, Skeleton, SlideOver, Spinner,
  STAGES, Stat, StatusChip,
  StreamingText, Table, TBody, TD, TH, THead, TR, Tabs, Textarea, Toggle, Tooltip,
  TopBar, useAnimatedNumber, useElapsed,
  type Command, type NotificationItem, type StageKey, type StatusKey,
} from "@/design";
import {
  ForgeMascot, ProjectLoader, ColdBoot, AgentWorking, ReconnectingBanner,
} from "@/design";
import { useToast } from "@/providers/toast-provider";

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-4">
        <Kicker>{id}</Kicker>
        <h2 className="fg-h2 mt-1">{title}</h2>
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
  ["--bg-app", "App"], ["--bg-surface", "Surface"], ["--bg-sunken", "Sunken"],
  ["--bg-hover", "Hover"], ["--border-default", "Border"], ["--fg-default", "FG"],
  ["--fg-muted", "Muted"], ["--accent", "Accent"], ["--link", "Link"],
];

const STATUSES: StatusKey[] = ["running", "queued", "blocked", "waiting", "passed", "failed", "paused", "done", "review"];

const WORKSPACE_NAV = [
  { key: "projects", label: "Projects", icon: "folder" as const },
  { key: "activity", label: "Activity", icon: "activity" as const },
  { key: "runners", label: "Runners", icon: "server" as const },
  { key: "sessions", label: "Sessions", icon: "inbox" as const },
];
const PROJECT_NAV = [
  { key: "board", label: "Board", icon: "board" as const },
  { key: "pipeline", label: "Pipeline", icon: "pipeline" as const },
  { key: "skills", label: "Skills", icon: "agent" as const },
  { key: "schedules", label: "Schedules", icon: "calendar" as const },
];

const COMMANDS: Command[] = [
  { label: "Go to Board", icon: "board", kbd: "G B" },
  { label: "Go to Pipeline", icon: "pipeline", kbd: "G P" },
  { label: "Go to Sessions", icon: "inbox", kbd: "G E" },
  { label: "All projects", icon: "folder", kbd: "G O" },
  { label: "New issue", icon: "plus", kbd: "C" },
  { label: "Pair a device", icon: "monitor" },
];

const NOTES: NotificationItem[] = [
  { id: "FRG-238", text: "Review agent requested changes", sub: "missing index migration", time: "4m", unread: true, hue: "amber" },
  { id: "FRG-224", text: "Pipeline blocked on PM policy", sub: "prod deploy needs approval", time: "22m", unread: true, hue: "red" },
  { id: "FRG-230", text: "Release agent opened PR #1284", sub: "ready to merge", time: "1h", unread: false, hue: "green" },
];

const TRACKER_CASES: { stage: StageKey; status: "running" | "done" | "failed" | "blocked"; label: string }[] = [
  { stage: "code", status: "running", label: "running · code" },
  { stage: "review", status: "failed", label: "failed · review" },
  { stage: "release", status: "done", label: "done" },
  { stage: "test", status: "blocked", label: "blocked · test" },
];

const NAV_ANCHORS = [
  "tokens", "type", "buttons", "status", "avatars", "tags", "forms", "cards",
  "pipeline", "kanban", "navrail", "topbar", "overlays", "states",
  "mascot", "skeletons", "progress", "feedback", "realtime",
  "formcontrols", "display", "disclosure", "data", "overlays2", "pageload",
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
      <span className="font-mono text-fg" style={{ fontSize: 15, minWidth: 64 }}>{elapsed}</span>
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
      <span className="font-mono text-fg" style={{ fontSize: 22, fontWeight: 700, minWidth: 72 }}>
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
  const [stage, setStage] = useState<StageKey>("code");
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
          setStage("test");
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
      <Button size="sm" variant="secondary" icon="trash" onClick={() => toast({ title: "Swept 1 zombie", description: "S-1037 cancelled", tone: "info" })}>
        Sweep zombies
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
        <PipelineTracker stage="code" status="running" variant="full" />
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
  const [navActive, setNavActive] = useState("board");

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
              <span className="inline-flex size-9 items-center justify-center rounded-lg" style={{ background: "var(--flame-500)", color: "#fff" }}>
                <Icon name="pipeline" size={20} strokeWidth={2} />
              </span>
              <div>
                <h1 className="fg-h1">Forge — Web v2 kit</h1>
                <p className="fg-body-sm">Design layer preview · light theme · Hanken Grotesk + JetBrains Mono</p>
              </div>
            </div>
          </header>

          <Section id="tokens" title="Color tokens" hint="Semantic layer (components reference these) + the 7 pipeline-stage hues.">
            <Row>
              {SEMANTIC_TOKENS.map(([token, label]) => (
                <div key={token} className="flex flex-col items-center gap-1.5">
                  <span className="size-14 rounded-md border border-line" style={{ background: `var(${token})` }} />
                  <span className="fg-caption">{label}</span>
                  <span className="font-mono text-[10px] text-subtle">{token}</span>
                </div>
              ))}
            </Row>
            <div className="my-5 h-px bg-[var(--border-subtle)]" />
            <Row>
              {STAGES.map((s) => (
                <div key={s.key} className="flex flex-col items-center gap-1.5">
                  <span className="size-9 rounded-pill" style={{ background: s.color }} />
                  <span className="font-mono text-[11px] text-muted">{s.label}</span>
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

          <Section id="status" title="Status & health" hint="Fixed status vocabulary. Running pulses and shows the active stage.">
            <div className="flex flex-col gap-4">
              <Row>
                {STATUSES.map((s) => (
                  <StatusChip key={s} status={s} stage={s === "running" ? "code" : undefined} />
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

          <Section id="pipeline" title="Pipeline tracker" hint="The hero motif — full (run header), compact (board rows), mini (dense lists).">
            <div className="flex flex-col gap-7">
              {TRACKER_CASES.map((c) => (
                <div key={c.label} className="flex flex-col gap-2">
                  <span className="fg-caption">{c.label}</span>
                  <PipelineTracker stage={c.stage} status={c.status} variant="full" />
                </div>
              ))}
              <div className="my-1 h-px bg-[var(--border-subtle)]" />
              <div className="flex items-center gap-6">
                <span className="fg-caption w-16">compact</span>
                <div className="max-w-xs flex-1"><PipelineTracker stage="code" status="running" variant="compact" /></div>
              </div>
              <div className="flex items-center gap-6">
                <span className="fg-caption w-16">mini</span>
                <PipelineTracker stage="code" status="running" variant="mini" />
                <PipelineTracker stage="release" status="done" variant="mini" />
                <PipelineTracker stage="review" status="failed" variant="mini" />
              </div>
            </div>
          </Section>

          <Section id="kanban" title="Kanban card">
            <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
              <KanbanCard id="FRG-241" title="Sweep orphaned runner jobs on reconnect" stage="code" status="running" cost="$0.42" assignee={{ initials: "SK", hue: "cobalt" }} />
              <KanbanCard id="FRG-229" title="Retry policy for failed test stage handoff" stage="code" status="blocked" cost="$0.39" assignee={{ initials: "MJ", hue: "green" }} />
              <KanbanCard id="FRG-230" title="Per-step cost analytics on the run timeline" stage="release" status="done" cost="$2.14" assignee={{ initials: "AR", hue: "flame" }} />
            </div>
          </Section>

          <Section id="kanban-board" title="Kanban board" hint="7 stage columns; the pipeline as a board. Horizontal snap-scroll when narrow.">
            <div className="flex h-[320px]">
              <KanbanBoard>
                {STAGES.map((s) => (
                  <KanbanColumn key={s.key} stage={s.key} count={s.key === "code" ? 2 : 0}>
                    {s.key === "code" && (
                      <>
                        <KanbanCard id="FRG-241" title="Sweep orphaned runner jobs on reconnect" stage="code" status="running" cost="$0.42" assignee={{ initials: "SK", hue: "cobalt" }} />
                        <KanbanCard id="FRG-229" title="Retry policy for failed test stage handoff" stage="code" status="blocked" cost="$0.39" assignee={{ initials: "MJ", hue: "green" }} />
                      </>
                    )}
                  </KanbanColumn>
                ))}
              </KanbanBoard>
            </div>
          </Section>

          <Section id="navrail" title="Nav rail" hint="Two-tier: Workspace links + project switcher + project sub-nav.">
            <div className="h-[460px] overflow-hidden rounded-md border border-line">
              <NavRail
                workspaceItems={WORKSPACE_NAV}
                projectItems={PROJECT_NAV}
                activeKey={navActive}
                onNavigate={setNavActive}
                project={{ name: "forge-core", initials: "FRG", tint: "var(--flame-50)", ink: "var(--flame-700)" }}
                user={{ initials: "SK" }}
              />
            </div>
          </Section>

          <Section id="topbar" title="Top bar">
            <div className="overflow-hidden rounded-md border border-line">
              <TopBar
                title="Board"
                notificationCount={2}
                onCommandPalette={() => setPaletteOpen(true)}
                onNotifications={() => setNotesOpen((v) => !v)}
              />
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
                <EmptyState title="No issues yet" message="Create one and the triage agent takes it from here." action={{ label: "New issue" }} />
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
              <div className="grid max-w-3xl grid-cols-3 gap-4">
                <KanbanColumnSkeleton cards={2} />
                <KanbanColumnSkeleton cards={1} />
                <KanbanCardSkeleton />
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
              <div className="flex items-center gap-6">
                <span className="fg-caption w-24">running mini</span>
                <PipelineTracker stage="code" status="running" variant="mini" />
              </div>
            </div>
          </Section>

          <Section id="feedback" title="Feedback — error & toasts" hint="Distinct error state with retry; toasts on create / sweep / failure (bottom-right).">
            <div className="flex flex-col gap-6">
              <div className="rounded-md border border-line">
                <ErrorState message="Couldn't load runs. Check your connection, then retry." onRetry={() => {}} />
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
                  { sid: "S-1043", iss: "FRG-241", st: "running" as StatusKey, stage: "code", cost: "$0.42" },
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
            web-v2 design layer · see docs/proposals/web-v2-redesign.md
          </footer>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={COMMANDS} />
    </div>
  );
}
