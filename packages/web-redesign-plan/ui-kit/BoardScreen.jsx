/* Forge UI Kit — BoardScreen.jsx
   The default view: "where is my project right now". A calm list of issues,
   each showing its live pipeline position. */

function IssueRow({ issue, onOpen, selected }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onClick={() => onOpen(issue)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ width: '100%', textAlign: 'left', display: 'grid',
        gridTemplateColumns: '54px minmax(0,1fr) 126px 132px 64px 28px', alignItems: 'center', gap: 14,
        padding: '14px 18px', background: selected ? 'var(--flame-50)' : hover ? 'var(--bg-hover)' : 'var(--bg-surface)',
        border: 'none', borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer',
        fontFamily: 'var(--font-sans)', transition: 'background var(--dur-fast) var(--ease-out)' }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-subtle)' }}>{issue.id}</span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--fg-default)', letterSpacing: '-0.01em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {issue.labels.map(l => <MonoTag key={l}>{l}</MonoTag>)}
          {issue.blockedBy > 0 && (
            <span title={`Blocked by ${issue.blockedBy}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 'var(--r-sm)', color: 'var(--amberw-600)', background: 'var(--amberw-50)', border: '1px solid var(--amberw-50)' }}>
              <Icon name="lock" size={11} />{issue.blockedBy}
            </span>
          )}
          {issue.blocks > 0 && (
            <span title={`Blocks ${issue.blocks}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 'var(--r-sm)', color: 'var(--fg-subtle)', background: 'var(--paper-50)', border: '1px solid var(--border-default)' }}>
              <Icon name="arrowRight" size={11} />{issue.blocks}
            </span>
          )}
        </span>
      </span>
      <PipelineTracker stage={issue.stage} status={issue.status} variant="mini" />
      <span><StatusChip status={issue.status} stage={issue.stage} size="sm" /></span>
      <Stat icon="dollar">{issue.cost.replace('$', '')}</Stat>
      <Avatar initials={issue.assignee} hue={issue.cohue} size={26} />
    </button>
  );
}

function FilterTab({ label, count, active, onClick }) {
  return (
    <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px',
      borderRadius: 'var(--r-pill)', border: '1px solid', cursor: 'pointer', fontFamily: 'var(--font-sans)',
      fontSize: 13, fontWeight: 600,
      background: active ? 'var(--ink-900)' : 'var(--bg-surface)',
      color: active ? '#fff' : 'var(--fg-muted)',
      borderColor: active ? 'var(--ink-900)' : 'var(--border-default)' }}>
      {label}
      {count != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11,
        color: active ? 'rgba(255,255,255,0.7)' : 'var(--fg-subtle)' }}>{count}</span>}
    </button>
  );
}

function BoardScreen({ onOpen, selectedId }) {
  const [filter, setFilter] = React.useState('all');
  const filters = [
    { key: 'all', label: 'All', count: ISSUES.length },
    { key: 'active', label: 'Active', count: ISSUES.filter(i => i.status === 'running').length },
    { key: 'review', label: 'Needs review', count: ISSUES.filter(i => i.status === 'review').length },
    { key: 'blocked', label: 'Blocked', count: ISSUES.filter(i => ['blocked', 'failed'].includes(i.status)).length },
  ];
  const shown = ISSUES.filter(i => {
    if (filter === 'all') return true;
    if (filter === 'active') return i.status === 'running';
    if (filter === 'review') return i.status === 'review';
    if (filter === 'blocked') return ['blocked', 'failed'].includes(i.status);
  });

  return (
    <div style={{ padding: '22px 26px', maxWidth: 1180, margin: '0 auto' }}>
      {/* Live banner */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, padding: '13px 16px',
        background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--shadow-xs)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: 'var(--fg-muted)' }}>
          <span className="forge-pulse" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)' }} />
          3 runs live
        </span>
        <span style={{ width: 1, height: 16, background: 'var(--border-default)' }} />
        <Stat icon="clock">12s median step</Stat>
        <Stat icon="dollar" style={{}}>5.81 today</Stat>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--fg-subtle)' }}>Broadcasting over WebSocket · synced</span>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        {filters.map(f => <FilterTab key={f.key} {...f} active={filter === f.key} onClick={() => setFilter(f.key)} />)}
        <div style={{ flex: 1 }} />
        <Button variant="secondary" size="sm" icon="filter">Filter</Button>
        <Button variant="secondary" size="sm" icon="list">Group</Button>
      </div>

      {/* List */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
        borderRadius: 'var(--r-lg)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '54px minmax(0,1fr) 126px 132px 64px 28px', gap: 14,
          padding: '10px 18px', borderBottom: '1px solid var(--border-default)', background: 'var(--paper-50)' }}>
          {['Issue', 'Title', 'Pipeline', 'Status', 'Cost', ''].map((h, i) => (
            <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: 'var(--fg-subtle)' }}>{h}</span>
          ))}
        </div>
        {shown.map(issue => <IssueRow key={issue.id} issue={issue} onOpen={onOpen} selected={selectedId === issue.id} />)}
      </div>
    </div>
  );
}

Object.assign(window, { BoardScreen, IssueRow, FilterTab });
