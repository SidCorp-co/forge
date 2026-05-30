/* Forge UI Kit — PipelineScreen.jsx
   The pipeline as a kanban: one column per stage, issues flow left→right.
   The clearest answer to "where is my project right now". */

function KanbanCard({ issue, onOpen }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onClick={() => onOpen(issue)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ width: '100%', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 9,
        padding: '12px 13px', background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
        borderRadius: 'var(--r-md)', cursor: 'pointer', boxShadow: hover ? 'var(--shadow-md)' : 'var(--shadow-xs)',
        transform: hover ? 'translateY(-1px)' : 'none', transition: 'box-shadow var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{issue.id}</span>
        <span style={{ marginLeft: 'auto' }}><Avatar initials={issue.assignee} hue={issue.cohue} size={20} /></span>
      </div>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-default)', lineHeight: 1.32, letterSpacing: '-0.01em' }}>{issue.title}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {issue.labels.slice(0, 2).map(l => <MonoTag key={l}>{l}</MonoTag>)}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 11.5, fontFamily: 'var(--font-mono)',
          color: issue.status === 'blocked' || issue.status === 'failed' ? 'var(--red-600)' : 'var(--fg-subtle)' }}>
          {(issue.status === 'running') && <span className="forge-pulse" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)' }} />}
          {(issue.status === 'blocked' || issue.status === 'failed') && <Icon name="x" size={12} strokeWidth={2.5} style={{ color: 'var(--red-500)' }} />}
          {issue.cost}
        </span>
      </div>
    </button>
  );
}

function PipelineScreen({ onOpen }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 26px 12px' }}>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-muted)' }}>
          Strictly sequential — a stage only starts once the previous one finishes. Drag is disabled in this prototype.
        </p>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button variant="secondary" size="sm" icon="filter">Filter</Button>
          <Button variant="secondary" size="sm" icon="settings">Configure stages</Button>
        </div>
      </div>
      <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', padding: '4px 26px 22px' }}>
        <div style={{ display: 'flex', gap: 14, height: '100%', minWidth: 'min-content' }}>
          {STAGES.map(stage => {
            const items = ISSUES.filter(i => i.stage === stage.key);
            return (
              <div key={stage.key} style={{ width: 248, flex: 'none', display: 'flex', flexDirection: 'column',
                background: 'var(--paper-100)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-lg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 13px 10px' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: stage.color }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600, color: 'var(--fg-default)', letterSpacing: '0.01em' }}>{stage.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-subtle)' }}>{items.length}</span>
                  <Icon name="plus" size={14} style={{ marginLeft: 'auto', color: 'var(--fg-subtle)' }} />
                </div>
                <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 9, padding: '2px 9px 12px' }}>
                  {items.length
                    ? items.map(i => <KanbanCard key={i.id} issue={i} onOpen={onOpen} />)
                    : <span style={{ fontSize: 12, color: 'var(--fg-disabled)', textAlign: 'center', padding: '14px 0', fontStyle: 'italic' }}>{stage.desc}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

window.PipelineScreen = PipelineScreen;
