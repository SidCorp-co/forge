/* Forge UI Kit — Data.jsx
   Static sample data + the 7-stage pipeline definition. */

const STAGES = [
  { key: 'triage',  label: 'triage',  color: 'var(--stage-triage)',  desc: 'Intake & label' },
  { key: 'clarify', label: 'clarify', color: 'var(--stage-clarify)', desc: 'Resolve ambiguity' },
  { key: 'plan',    label: 'plan',    color: 'var(--stage-plan)',    desc: 'Break into tasks' },
  { key: 'code',    label: 'code',    color: 'var(--stage-code)',    desc: 'Implement' },
  { key: 'review',  label: 'review',  color: 'var(--stage-review)',  desc: 'Self-review diff' },
  { key: 'test',    label: 'test',    color: 'var(--stage-test)',    desc: 'Run the suite' },
  { key: 'release', label: 'release', color: 'var(--stage-release)', desc: 'Open PR / ship' },
];
const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));

// status: 'running' | 'review' | 'queued' | 'passed' | 'failed' | 'blocked' | 'done'
const ISSUES = [
  { id: 'ISS-273', title: 'Device-centric runner management + onboarding UX fixes', stage: 'release', status: 'done', labels: ['web', 'onboarding'], cost: '$4.20', assignee: 'SK', cohue: 'cobalt', updated: '2h', tasks: 6, taskDone: 6, rich: true, blockedBy: 1, blocks: 1 },
  { id: 'FRG-241', title: 'Sweep orphaned runner jobs on reconnect', stage: 'code', status: 'running', labels: ['backend', 'runner'], cost: '$0.42', assignee: 'SK', cohue: 'cobalt', updated: '2m', tasks: 5, taskDone: 2, blockedBy: 1, blocks: 0 },
  { id: 'FRG-236', title: 'Broadcast pipeline events over WebSocket fan-out', stage: 'test', status: 'running', labels: ['core', 'realtime'], cost: '$0.66', assignee: 'SK', cohue: 'cobalt', updated: '14m', tasks: 4, taskDone: 3, blockedBy: 0, blocks: 2 },
  { id: 'FRG-233', title: 'Desktop pairing flow for Tauri dev app', stage: 'plan', status: 'running', labels: ['dev', 'auth'], cost: '$0.21', assignee: 'MJ', cohue: 'green', updated: '22m', tasks: 3, taskDone: 1 },
  { id: 'FRG-230', title: 'Per-step cost analytics on the run timeline', stage: 'release', status: 'done', labels: ['web', 'analytics'], cost: '$2.14', assignee: 'AR', cohue: 'flame', updated: '1h', tasks: 7, taskDone: 7 },
  { id: 'FRG-229', title: 'Retry policy for failed test stage handoff', stage: 'code', status: 'blocked', labels: ['pipeline'], cost: '$0.39', assignee: 'MJ', cohue: 'green', updated: '1h', tasks: 4, taskDone: 2, blockedBy: 2, blocks: 0 },
  { id: 'FRG-227', title: 'Skill registry sync across projects', stage: 'triage', status: 'queued', labels: ['skills'], cost: '$0.00', assignee: 'SK', cohue: 'cobalt', updated: '3h', tasks: 0, taskDone: 0 },
  { id: 'FRG-224', title: 'PM policy: auto-escalate prod deploys', stage: 'review', status: 'failed', labels: ['pm', 'integrations'], cost: '$0.91', assignee: 'AR', cohue: 'flame', updated: '4h', tasks: 5, taskDone: 4, blockedBy: 0, blocks: 1 },
];

// Run timeline for the detail panel (FRG-241)
const RUN_TIMELINE = [
  { stage: 'triage',  state: 'done',    agent: 'Triage agent',  note: 'Labeled backend · runner. Routed to pipeline.', dur: '4s',  cost: '$0.01' },
  { stage: 'clarify', state: 'done',    agent: 'Clarify agent', note: 'No open questions — acceptance criteria clear.',  dur: '6s',  cost: '$0.02' },
  { stage: 'plan',    state: 'done',    agent: 'Plan agent',    note: 'Decomposed into 5 tasks. Touch points: runner, jobs.', dur: '11s', cost: '$0.05' },
  { stage: 'code',    state: 'running', agent: 'Code agent',    note: 'Editing reconnect handler in runner crate…', dur: '38s', cost: '$0.34' },
  { stage: 'review',  state: 'todo',    agent: 'Review agent',  note: 'Waiting for code to finish.', dur: null, cost: null },
  { stage: 'test',    state: 'todo',    agent: 'Test agent',    note: 'Queued.', dur: null, cost: null },
  { stage: 'release', state: 'todo',    agent: 'Release agent', note: 'Queued.', dur: null, cost: null },
];

const DEVICES = [
  { name: 'sid-mbp-16', os: 'macOS 15.2', status: 'online', runners: [
      { project: 'forge-core', model: 'claude-sonnet', status: 'busy', job: 'FRG-241 · code' },
      { project: 'forge-web',  model: 'claude-sonnet', status: 'idle', job: null },
  ], quota: '62%' },
  { name: 'ci-runner-01', os: 'Ubuntu 24.04', status: 'online', runners: [
      { project: 'forge-core', model: 'claude-opus',   status: 'busy', job: 'FRG-238 · test' },
  ], quota: '88%' },
  { name: 'arvi-studio', os: 'macOS 14.6', status: 'offline', runners: [
      { project: 'forge-web',  model: 'claude-sonnet', status: 'offline', job: null },
  ], quota: '—' },
];

// Sidebar navigation — two tiers: workspace-level and project-scoped
const NAV_WORKSPACE = [
  { key: 'projects', label: 'Projects', icon: 'folder' },
  { key: 'activity', label: 'Activity', icon: 'activity' },
  { key: 'runners',  label: 'Runners',  icon: 'server' },
];
const NAV_PROJECT = [
  { key: 'board',    label: 'Board',     icon: 'board' },
  { key: 'pipeline', label: 'Pipeline',  icon: 'pipeline' },
  { key: 'sessions', label: 'Sessions',  icon: 'inbox' },
  { key: 'schedules',label: 'Schedules', icon: 'calendar' },
  { key: 'skills',   label: 'Skills',    icon: 'agent' },
];

// Agent sessions index (GET /api/agent-sessions) + queue-stats
const QUEUE_STATS = { active: 3, queued: 2, zombies: 1, medianWait: '6s' };
const SESSIONS = [
  { sid: 'S-1043', issueId: 'FRG-241', title: 'Sweep orphaned runner jobs on reconnect', agent: 'Code agent',    stage: 'code',    model: 'claude-sonnet', status: 'running',  turns: 8, cost: '$0.42', dur: '1m 04s', device: 'sid-mbp-16',  updated: 'now' },
  { sid: 'S-1042', issueId: 'FRG-238', title: 'Add pgvector HNSW index to memory search', agent: 'Review agent',  stage: 'review',  model: 'claude-opus',   status: 'running',  turns: 3, cost: '$1.08', dur: '2m 11s', device: 'ci-runner-01', updated: '2m' },
  { sid: 'S-1041', issueId: 'FRG-236', title: 'Broadcast pipeline events over WebSocket', agent: 'Test agent',    stage: 'test',    model: 'claude-sonnet', status: 'running',  turns: 5, cost: '$0.66', dur: '48s',    device: 'sid-mbp-16',  updated: '4m' },
  { sid: 'S-1040', issueId: 'FRG-233', title: 'Desktop pairing flow for Tauri dev app',   agent: 'Plan agent',    stage: 'plan',    model: 'claude-sonnet', status: 'queued',   turns: 0, cost: '$0.00', dur: '\u2014',     device: '\u2014',           updated: '6m' },
  { sid: 'S-1039', issueId: 'FRG-224', title: 'PM policy: auto-escalate prod deploys',    agent: 'Review agent',  stage: 'review',  model: 'claude-opus',   status: 'failed',   turns: 6, cost: '$0.91', dur: '3m 02s', device: 'ci-runner-01', updated: '22m' },
  { sid: 'S-1038', issueId: 'FRG-230', title: 'Per-step cost analytics on run timeline',  agent: 'Release agent', stage: 'release', model: 'claude-sonnet', status: 'done',     turns: 4, cost: '$2.14', dur: '5m 20s', device: 'sid-mbp-16',  updated: '1h' },
  { sid: 'S-1037', issueId: 'FRG-229', title: 'Retry policy for failed test stage',       agent: 'Code agent',    stage: 'code',    model: 'claude-sonnet', status: 'zombie',   turns: 2, cost: '$0.39', dur: '14m',    device: 'arvi-studio',  updated: '14m' },
  { sid: 'S-1036', issueId: 'FRG-227', title: 'Skill registry sync across projects',      agent: 'Triage agent',  stage: 'triage',  model: 'claude-haiku',  status: 'queued',   turns: 0, cost: '$0.00', dur: '\u2014',     device: '\u2014',           updated: '3h' },
];

// Live activity feed — agent handoffs across projects
const ACTIVITY = [
  { id: 'FRG-241', stage: 'code',    agent: 'Code agent',    verb: 'started editing', detail: 'runner crate · reconnect handler', time: 'just now', hue: 'flame' },
  { id: 'FRG-236', stage: 'test',    agent: 'Test agent',    verb: 'passed', detail: '142 tests · 0 failures', time: '1m', hue: 'green' },
  { id: 'FRG-238', stage: 'review',  agent: 'Review agent',  verb: 'requested changes on', detail: 'missing index migration', time: '4m', hue: 'amber' },
  { id: 'FRG-233', stage: 'plan',    agent: 'Plan agent',    verb: 'decomposed', detail: '3 tasks · touched dev, auth', time: '12m', hue: 'cobalt' },
  { id: 'FRG-224', stage: 'review',  agent: 'Review agent',  verb: 'failed', detail: 'policy: prod deploy needs approval', time: '22m', hue: 'red' },
  { id: 'FRG-230', stage: 'release', agent: 'Release agent', verb: 'opened PR', detail: '#1284 → main', time: '1h', hue: 'green' },
  { id: 'FRG-236', stage: 'code',    agent: 'Code agent',    verb: 'handed off to', detail: 'test agent', time: '1h', hue: 'cobalt' },
  { id: 'FRG-227', stage: 'triage',  agent: 'Triage agent',  verb: 'labeled', detail: 'skills · routed to pipeline', time: '3h', hue: 'cobalt' },
];

// Skill registry — shared agent skills
const SKILLS = [
  { name: 'commit-conventions', stage: 'code',    scope: 'global',  desc: 'Conventional-commit messages & PR titles', synced: true,  uses: 312 },
  { name: 'pgvector-migrations',stage: 'code',    scope: 'project', desc: 'Safe HNSW index migration patterns', synced: true,  uses: 41 },
  { name: 'test-runner',        stage: 'test',    scope: 'global',  desc: 'Detect & run the right test command', synced: true,  uses: 508 },
  { name: 'review-checklist',   stage: 'review',  scope: 'global',  desc: 'Diff review heuristics & risk flags', synced: false, uses: 197 },
  { name: 'triage-router',      stage: 'triage',  scope: 'global',  desc: 'Label, prioritize & route incoming issues', synced: true,  uses: 624 },
  { name: 'release-notes',      stage: 'release', scope: 'project', desc: 'Draft changelog from merged work', synced: true,  uses: 88 },
];

// Scheduled pipeline runs
const SCHEDULES = [
  { name: 'Nightly dependency bumps', cadence: 'Every day · 02:00', next: 'in 6h', target: 'forge-core', enabled: true,  last: 'passed' },
  { name: 'Weekly flaky-test triage',  cadence: 'Mon · 09:00', next: 'in 2d', target: 'forge-core', enabled: true,  last: 'passed' },
  { name: 'Docs link audit',           cadence: 'Every day · 04:00', next: 'in 8h', target: 'forge-web',  enabled: false, last: 'paused' },
  { name: 'Security advisory sweep',   cadence: 'Sun · 23:00', next: 'in 4d', target: 'all projects', enabled: true,  last: 'failed' },
];

const NOTIFICATIONS = [
  { id: 'FRG-238', text: 'Review agent requested changes', sub: 'missing index migration', time: '4m', unread: true,  hue: 'amber' },
  { id: 'FRG-224', text: 'Pipeline blocked on PM policy', sub: 'prod deploy needs approval', time: '22m', unread: true,  hue: 'red' },
  { id: 'FRG-230', text: 'Release agent opened PR #1284', sub: 'ready to merge', time: '1h', unread: false, hue: 'green' },
];

// ⌘K command palette entries
const COMMANDS = [
  { label: 'Go to Board',     icon: 'board',    nav: 'board',    kbd: 'G B' },
  { label: 'All projects',    icon: 'folder',   nav: 'projects', kbd: 'G O' },
  { label: 'Go to Pipeline',  icon: 'pipeline', nav: 'pipeline', kbd: 'G P' },
  { label: 'Go to Sessions',  icon: 'inbox',    nav: 'sessions', kbd: 'G E' },
  { label: 'Go to Runners',   icon: 'server',   nav: 'runners',  kbd: 'G R' },
  { label: 'Go to Activity',  icon: 'activity', nav: 'activity', kbd: 'G A' },
  { label: 'Go to Skills',    icon: 'agent',    nav: 'skills',   kbd: 'G S' },
  { label: 'New issue',       icon: 'plus',     act: 'new',      kbd: 'C' },
  { label: 'Pair a device',   icon: 'monitor',  nav: 'runners' },
  { label: 'Open session — FRG-241 · Sweep orphaned runner jobs', icon: 'agent', act: 'open241' },
];

// Agent session — the conversation thread for FRG-241 (Code agent)
const SESSION_TURNS = [
  { role: 'prompt', author: 'Triage → Code', text: 'Sweep orphaned runner jobs when a runner reconnects. They currently stay stuck in “running” forever, which holds the pipeline.' },
  { role: 'agent', author: 'Code agent', text: 'On it. The fix is to detect jobs left in `running` whose runner has just reconnected, then sweep them after a short grace window so we don’t race an in-flight heartbeat.' },
  { role: 'tool', kind: 'read', title: 'Read 2 files', detail: 'runner/src/jobs.rs · runner/src/reconnect.rs', cost: '$0.04' },
  { role: 'tool', kind: 'edit', title: 'Edited runner/src/reconnect.rs', detail: '+24 −6',
    diff: ['+ // sweep jobs orphaned while this runner was away', '+ let stale = jobs.running_for(runner.id);', '+ scheduler.sweep_after(stale, Duration::from_secs(30));'], cost: '$0.21' },
  { role: 'agent', author: 'Code agent', text: 'Added a `sweep_orphaned_jobs` call on reconnect with a 30s grace window, and I’m emitting a `job.swept` event so the pipeline view updates over WebSocket.' },
  { role: 'tool', kind: 'edit', title: 'Edited core/src/jobs/events.rs', detail: '+8 −0', cost: '$0.06' },
  { role: 'tool', kind: 'test', title: 'cargo test', detail: '142 passed · 0 failed', state: 'passed', cost: '$0.05' },
  { role: 'agent', author: 'Code agent', text: 'Tests are green. Writing one integration test that simulates a reconnect with stuck jobs, then I’ll hand off to review.', streaming: true },
];

const SESSION_FILES = [
  { path: 'runner/src/reconnect.rs', add: 24, del: 6 },
  { path: 'core/src/jobs/events.rs', add: 8, del: 0 },
];

// Workspace projects (GET /api/projects, /api/projects/health)
const PROJECTS = [
  { id: 'forge-core',     name: 'forge-core',     key: 'FRG', desc: 'Hono backend, runner & MCP server on Postgres', repo: 'SidCorp-co/forge', tint: 'var(--flame-50)',  ink: 'var(--flame-700)',  activeRuns: 3, openIssues: 12, runners: 2, health: 'attention', members: ['SK', 'AR', 'MJ'], updated: 'now', mins: 0,    spend: '$5.81', pinned: true },
  { id: 'forge-web',      name: 'forge-web',      key: 'FWB', desc: 'Next.js cloud interface',                      repo: 'SidCorp-co/forge', tint: 'var(--cobalt-50)', ink: 'var(--cobalt-700)', activeRuns: 1, openIssues: 7,  runners: 1, health: 'healthy',   members: ['AR', 'SK'],       updated: '8m',  mins: 8,    spend: '$1.20', pinned: true },
  { id: 'data-pipeline',  name: 'data-pipeline',  key: 'DPL', desc: 'ETL + embeddings ingestion jobs',             repo: 'SidCorp-co/data',  tint: 'var(--amberw-50)', ink: 'var(--amberw-600)', activeRuns: 1, openIssues: 9,  runners: 2, health: 'attention', members: ['SK', 'MJ', 'AR'], updated: '6m',  mins: 6,    spend: '$3.10' },
  { id: 'forge-runner',   name: 'forge-runner',   key: 'FRN', desc: 'Rust job runner crate',                       repo: 'SidCorp-co/forge', tint: '#FCEBE9',          ink: 'var(--red-600)',    activeRuns: 2, openIssues: 5,  runners: 2, health: 'attention', members: ['MJ', 'SK'],       updated: '14m', mins: 14,   spend: '$2.04' },
  { id: 'forge-contracts',name: 'forge-contracts',key: 'FCT', desc: 'Shared REST contract & types',                repo: 'SidCorp-co/forge', tint: 'var(--green-50)',  ink: 'var(--green-600)',  activeRuns: 1, openIssues: 3,  runners: 1, health: 'healthy',   members: ['SK'],             updated: '20m', mins: 20,   spend: '$0.42' },
  { id: 'billing-svc',    name: 'billing-svc',    key: 'BIL', desc: 'Stripe billing & usage metering',            repo: 'SidCorp-co/billing',tint: '#FCEBE9',         ink: 'var(--red-600)',    activeRuns: 0, openIssues: 8,  runners: 1, health: 'down',      members: ['SK', 'AR'],       updated: '25m', mins: 25,   spend: '$0.31' },
  { id: 'forge-mcp',      name: 'forge-mcp',      key: 'FMC', desc: 'MCP tool server & registry',                 repo: 'SidCorp-co/forge', tint: '#E5F3F6',          ink: '#176B85',           activeRuns: 1, openIssues: 6,  runners: 1, health: 'healthy',   members: ['AR'],             updated: '32m', mins: 32,   spend: '$0.88' },
  { id: 'notify-svc',     name: 'notify-svc',     key: 'NTF', desc: 'Notifications & webhook delivery',           repo: 'SidCorp-co/notify', tint: 'var(--green-50)', ink: 'var(--green-600)',  activeRuns: 1, openIssues: 4,  runners: 1, health: 'healthy',   members: ['MJ'],             updated: '40m', mins: 40,   spend: '$0.52' },
  { id: 'forge-dev',      name: 'forge-dev',      key: 'FDV', desc: 'Tauri desktop app — local codebase access', repo: 'SidCorp-co/forge', tint: 'var(--cobalt-50)', ink: 'var(--cobalt-700)', activeRuns: 0, openIssues: 4,  runners: 1, health: 'healthy',   members: ['MJ'],             updated: '1h',  mins: 60,   spend: '$0.00' },
  { id: 'forge-cli',      name: 'forge-cli',      key: 'FCL', desc: 'Install script & CLI binary',                repo: 'SidCorp-co/forge', tint: '#E5F3F6',          ink: '#176B85',           activeRuns: 0, openIssues: 3,  runners: 0, health: 'healthy',   members: ['MJ'],             updated: '2h',  mins: 120,  spend: '$0.10' },
  { id: 'forge-docs',     name: 'forge-docs',     key: 'FDC', desc: 'Docs & guides site',                         repo: 'SidCorp-co/forge-docs',tint: '#EFEAFB',       ink: '#6A4BB8',           activeRuns: 0, openIssues: 2,  runners: 0, health: 'idle',      members: ['AR'],             updated: '3h',  mins: 180,  spend: '$0.00' },
  { id: 'legacy-monolith',name: 'legacy-monolith',key: 'LGM', desc: 'Archived — superseded by services',      repo: 'SidCorp-co/legacy', tint: 'var(--paper-100)', ink: 'var(--ink-600)',    activeRuns: 0, openIssues: 0,  runners: 0, health: 'idle',      members: ['AR'],             updated: '3d',  mins: 4320, spend: '$0.00', archived: true },
];

// Issue detail (GET /api/issues/:id + comments / tasks / activity / dependencies)
const ISSUE_DESC = 'Runners that reconnect after a network blip leave their in-flight jobs stuck in `running` forever, which holds the whole pipeline. Detect jobs whose runner has just reconnected and sweep them after a short grace window, emitting a `job.swept` event so every board updates live over WebSocket.';
const ISSUE_TASKS = [
  { text: 'Detect orphaned jobs on runner reconnect', done: true },
  { text: 'Add grace-period sweep to the job table', done: true },
  { text: 'Emit pipeline event on cleanup', done: false },
  { text: 'Cover with an integration test', done: false },
  { text: 'Update runner docs', done: false },
];
const ISSUE_COMMENTS = [
  { author: 'Sid Kumar', initials: 'SK', hue: 'cobalt', time: '2h', text: 'Saw this on ci-runner-01 twice this week — jobs stuck after a VPN drop.' },
  { author: 'Plan agent', agent: true, time: '1h', text: 'Decomposed into 5 tasks. Main risk is racing an in-flight heartbeat; using a 30s grace window.' },
  { author: 'Arvi R', initials: 'AR', hue: 'flame', time: '24m', text: 'Make sure the swept event also clears the manual-hold flag if it was set.' },
];
const ISSUE_DEPS = {
  blockedBy: [{ id: 'FRG-236', title: 'WebSocket fan-out', status: 'running' }],
  blocks: [{ id: 'FRG-245', title: 'Runner auto-heal policy', status: 'queued' }],
};

Object.assign(window, { STAGES, STAGE_INDEX, ISSUES, RUN_TIMELINE, DEVICES, NAV_WORKSPACE, NAV_PROJECT, ACTIVITY, SKILLS, SCHEDULES, NOTIFICATIONS, COMMANDS, SESSION_TURNS, SESSION_FILES, QUEUE_STATS, SESSIONS, PROJECTS, ISSUE_DESC, ISSUE_TASKS, ISSUE_COMMENTS, ISSUE_DEPS });
