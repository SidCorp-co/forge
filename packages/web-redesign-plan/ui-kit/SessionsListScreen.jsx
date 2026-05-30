/* Forge UI Kit — SessionsListScreen.jsx
   The agent-sessions index (GET /api/agent-sessions) with queue-stats and
   sweep-zombies. The first-class home for every running/queued/failed agent run.
   Click a row → the SessionScreen conversation. */

const SESSION_STATUS = {
  running:  { label: 'running',  fg: 'var(--cobalt-700)', bg: 'var(--cobalt-50)', dot: 'var(--cobalt-500)' },
  queued:   { label: 'queued',   fg: 'var(--ink-600)',    bg: 'var(--paper-100)', dot: 'var(--ink-400)' },
  done:     { label: 'done',     fg: 'var(--green-600)',  bg: 'var(--green-50)',  dot: 'var(--green-500)' },
  failed:   { label: 'failed',   fg: 'var(--red-600)',    bg: 'var(--red-50)',    dot: 'var(--red-500)' },
  zombie:   { label: 'zombie',   fg: 'var(--amberw-600)', bg: 'var(--amberw-50)', dot: 'var(--amberw-500)' },
  canceled: { label: 'canceled', fg: 'var(--ink-500)',    bg: 'var(--paper-100)', dot: 'var(--ink-400)' },
};

function StatCard({ label, value, tone, pulse }) {
  const tones = { accent: 'var(--accent-text)', amber: 'var(--amberw-600)', default: 'var(--ink-900)' };
  return (
    <div style={{ flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)',
      boxShadow: 'var(--shadow-xs)', padding: '14px 16px' }}>
      <div className="fg-overline" style={{ marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {pulse && <span className="forge-pulse" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)' }} />}
        <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', color: tones[tone] || tones.default, fontFamily: 'var(--font-sans)' }}>{value}</span>
      </div>
    </div>
  );
}

function rowAction(status) {
  return { running: { label: 'Cancel', icon: 'stop', variant: 'ghost' },
           failed:  { label: 'Retry',  icon: 'rerun', variant: 'secondary' },
           zombie:  { label: 'Sweep',  icon: 'rerun', variant: 'secondary' },
           done:    { label: 'Rerun',  icon: 'rerun', variant: 'ghost' },
           queued:  { label: 'Abort',  icon: 'x', variant: 'ghost' },
           canceled:{ label: 'Rerun',  icon: 'rerun', variant: 'ghost' } }[status];
}

function sessionToIssue(s) {
  const status = s.status === 'zombie' ? 'blocked' : ['queued', 'done', 'failed'].includes(s.status) ? s.status : 'running';
  return { id: s.issueId, title: s.title, stage: s.stage, status, cost: s.cost, labels: [], assignee: 'SK', cohue: 'cobalt' };
}

function SessionsListScreen({ onOpen, onSweep }) {
  const [filter, setFilter] = React.useState('all');
  const filters = [
    { key: 'all', label: 'All', count: SESSIONS.length },
    { key: 'running', label: 'Running', count: SESSIONS.filter(s => s.status === 'running').length },
    { key: 'queued', label: 'Queued', count: SESSIONS.filter(s => s.status === 'queued').length },
    { key: 'attention', label: 'Needs attention', count: SESSIONS.filter(s => ['failed', 'zombie'].includes(s.status)).length },
  ];
  const shown = SESSIONS.filter(s =>
    filter === 'all' ? true :
    filter === 'attention' ? ['failed', 'zombie'].includes(s.status) : s.status === filter);

  const cols = '78px minmax(0,1fr) 130px 52px 70px 86px 122px 96px';

  return (
    <div style={{ padding: '22px 26px', maxWidth: 1180, margin: '0 auto' }}>
      {/* Queue stats */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 18, alignItems: 'stretch' }}>
        <StatCard label="Active" value={QUEUE_STATS.active} tone="accent" pulse />
        <StatCard label="Queued" value={QUEUE_STATS.queued} />
        <StatCard label="Zombies" value={QUEUE_STATS.zombies} tone={QUEUE_STATS.zombies ? 'amber' : 'default'} />
        <StatCard label="Median wait" value={QUEUE_STATS.medianWait} />
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8, paddingLeft: 4 }}>
          <Button variant={QUEUE_STATS.zombies ? 'secondary' : 'ghost'} icon="rerun" onClick={onSweep}>Sweep zombies</Button>
          <Button variant="ghost" icon="stop" style={{ justifyContent: 'center' }}>Abort all</Button>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        {filters.map(f => <FilterTab key={f.key} {...f} active={filter === f.key} onClick={() => setFilter(f.key)} />)}
      </div>

      {/* Sessions table */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)',
        overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, padding: '10px 18px',
          borderBottom: '1px solid var(--border-default)', background: 'var(--paper-50)' }}>
          {['Session', 'Issue · agent', 'Model', 'Turns', 'Cost', 'Duration', 'Status', ''].map((h, i) => (
            <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-subtle)' }}>{h}</span>
          ))}
        </div>
        {shown.map((s, idx) => {
          const m = SESSION_STATUS[s.status];
          const act = rowAction(s.status);
          return (
            <div key={s.sid} onClick={() => onOpen(sessionToIssue(s))}
              style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, alignItems: 'center', padding: '13px 18px',
                borderBottom: idx < shown.length - 1 ? '1px solid var(--border-subtle)' : 'none', cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{s.sid}</span>
              <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-default)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{s.issueId}</span>
                  <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>· {s.agent}</span>
                </span>
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{s.model}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-default)' }}>{s.turns}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-default)' }}>{s.cost}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-subtle)' }}>{s.dur}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)',
                padding: '3px 9px', borderRadius: 'var(--r-pill)', color: m.fg, background: m.bg, justifySelf: 'start' }}>
                <span className={s.status === 'running' ? 'forge-pulse' : ''} style={{ width: 6, height: 6, borderRadius: 999, background: m.dot }} />
                {m.label}
              </span>
              <span onClick={e => e.stopPropagation()} style={{ justifySelf: 'end' }}>
                <Button variant={act.variant} size="sm" icon={act.icon}>{act.label}</Button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

window.SessionsListScreen = SessionsListScreen;
