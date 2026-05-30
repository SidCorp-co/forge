"use client";

import { useState } from "react";
import {
  Avatar, Button, Card, CardContent, CardHeader, CardTitle,
  CommandPalette, EmptyState, Field, HealthDot, Icon, Input, Kicker,
  KanbanCard, MonoTag, NavRail, NotificationsMenu,
  PipelineTracker, ProjectMark, SegmentedControl, Spinner, STAGES, Stat,
  StatusChip, Toggle, TopBar,
  type Command, type NotificationItem, type StageKey, type StatusKey,
} from "@/design";

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
];

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
              <Field label="Project name" hint="Sentence case, never New Project.">
                <Input placeholder="forge-core" />
              </Field>
              <Field label="Search">
                <Input icon="search" placeholder="Search or jump to…" />
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
                <EmptyState message="No issues yet. Create one to start the pipeline." action={{ label: "New issue" }} />
              </div>
              <div className="flex items-center justify-center gap-3 rounded-md border border-line p-10">
                <Spinner /> <span className="fg-body-sm">Loading runs…</span>
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
