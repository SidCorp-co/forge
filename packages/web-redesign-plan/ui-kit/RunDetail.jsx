/* Forge UI Kit — RunDetail.jsx
   Right-hand slide-over panel for an issue's pipeline run.
   Header → controls → full tracker → tabbed timeline. Context opens here
   rather than navigating away. */

function TimelineRow({ item, isLast }) {
  const stateColor = { done: 'var(--green-500)', running: 'var(--accent)', todo: 'var(--border-strong)' }[item.state];
  const stage = STAGES.find(s => s.key === item.stage);
  return (
    <div style={{ display: 'flex', gap: 13 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none', width: 18 }}>
        <span style={{ width: 14, height: 14, borderRadius: 999, flex: 'none', marginTop: 2,
          background: item.state === 'todo' ? 'var(--bg-surface)' : stateColor,
          border: `2px solid ${stateColor}`,
          boxShadow: item.state === 'running' ? '0 0 0 4px var(--flame-100)' : 'none' }} />
        {!isLast && <span style={{ flex: 1, width: 2, background: item.state === 'done' ? 'var(--green-500)' : 'var(--border-default)', marginTop: 3, minHeight: 22 }} />}
      </div>
      <div style={{ paddingBottom: 18, flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 700,
            color: item.state === 'running' ? 'var(--accent-text)' : item.state === 'done' ? 'var(--green-600)' : 'var(--fg-subtle)' }}>{item.stage}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-default)' }}>{item.agent}</span>
          {item.dur && <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <Stat icon="clock">{item.dur}</Stat><Stat icon="dollar">{item.cost.replace('$', '')}</Stat>
          </span>}
        </div>
        <p style={{ margin: '5px 0 0', fontSize: 13, lineHeight: 1.5, color: item.state === 'todo' ? 'var(--fg-disabled)' : 'var(--fg-muted)' }}>{item.note}</p>
      </div>
    </div>
  );
}

function RunDetail({ issue, onClose, onOpenSession }) {
  const [tab, setTab] = React.useState('timeline');
  if (!issue) return null;
  const tabs = [['timeline', 'Timeline'], ['tasks', 'Tasks'], ['cost', 'Cost']];

  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(24,27,34,0.18)',
        backdropFilter: 'blur(2px)', animation: 'forge-fade var(--dur-base) var(--ease-out)' }} />
      <aside style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 480, background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border-default)', boxShadow: 'var(--shadow-lg)', display: 'flex',
        flexDirection: 'column', animation: 'forge-slide var(--dur-slow) var(--ease-out)' }}>
        {/* Header */}
        <div style={{ padding: '18px 22px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-subtle)' }}>{issue.id}</span>
            <StatusChip status={issue.status} stage={issue.stage} size="sm" />
            <button onClick={onClose} style={{ marginLeft: 'auto', width: 30, height: 30, display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 'var(--r-sm)',
              cursor: 'pointer', color: 'var(--fg-subtle)' }}>
              <Icon name="x" size={18} />
            </button>
          </div>
          <h2 style={{ margin: '10px 0 12px', fontSize: 19, fontWeight: 700, lineHeight: 1.25, letterSpacing: '-0.015em', color: 'var(--ink-900)' }}>{issue.title}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <MonoTag><Icon name="branch" size={12} style={{ verticalAlign: -1, marginRight: 4 }} />feat/runner-sweep</MonoTag>
            <Stat icon="dollar">{issue.cost.replace('$', '')} this run</Stat>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', gap: 8, padding: '14px 22px', borderBottom: '1px solid var(--border-subtle)' }}>
          {issue.status === 'running'
            ? <Button variant="primary" icon="pause">Pause run</Button>
            : <Button variant="primary" icon="play">Run pipeline</Button>}
          <Button variant="secondary" icon="agent" onClick={() => onOpenSession && onOpenSession(issue)}>Open session</Button>
          <Button variant="secondary" icon="fork">Fork</Button>
          <Button variant="ghost" icon="more" style={{ marginLeft: 'auto', padding: '9px 10px' }} />
        </div>

        {/* Full tracker */}
        <div style={{ padding: '20px 22px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
          <PipelineTracker stage={issue.stage} status={issue.status} variant="full" />
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: '0 16px', borderBottom: '1px solid var(--border-default)' }}>
          {tabs.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ padding: '12px 12px', background: 'transparent', border: 'none',
              borderBottom: `2px solid ${tab === k ? 'var(--accent)' : 'transparent'}`, cursor: 'pointer',
              fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, marginBottom: -1,
              color: tab === k ? 'var(--fg-default)' : 'var(--fg-subtle)' }}>{l}</button>
          ))}
        </div>

        {/* Tab body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
          {tab === 'timeline' && (
            <div>
              <div className="fg-overline" style={{ marginBottom: 16 }}>Agent handoffs</div>
              {RUN_TIMELINE.map((item, i) => <TimelineRow key={item.stage} item={item} isLast={i === RUN_TIMELINE.length - 1} />)}
            </div>
          )}
          {tab === 'tasks' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {['Detect orphaned jobs on runner reconnect', 'Add grace-period sweep to job table', 'Emit pipeline event on cleanup', 'Cover with integration test', 'Update runner docs'].map((t, i) => (
                <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px',
                  background: 'var(--paper-50)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)' }}>
                  <span style={{ width: 18, height: 18, borderRadius: 5, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: i < 2 ? 'var(--green-500)' : 'var(--bg-surface)', border: `1.5px solid ${i < 2 ? 'var(--green-500)' : 'var(--border-strong)'}` }}>
                    {i < 2 && <Icon name="check" size={12} strokeWidth={3} style={{ color: '#fff' }} />}
                  </span>
                  <span style={{ fontSize: 13.5, color: i < 2 ? 'var(--fg-subtle)' : 'var(--fg-default)',
                    textDecoration: i < 2 ? 'line-through' : 'none' }}>{t}</span>
                </label>
              ))}
            </div>
          )}
          {tab === 'cost' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--ink-900)', fontFamily: 'var(--font-sans)' }}>$0.42</span>
                <span style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>this run · 4 stages</span>
              </div>
              {RUN_TIMELINE.filter(t => t.cost).map(t => (
                <div key={t.stage} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-muted)', width: 60 }}>{t.stage}</span>
                  <div style={{ flex: 1, height: 8, borderRadius: 999, background: 'var(--paper-200)', overflow: 'hidden' }}>
                    <div style={{ width: `${parseFloat(t.cost.replace('$', '')) / 0.34 * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 999 }} />
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-default)', width: 44, textAlign: 'right' }}>{t.cost}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

window.RunDetail = RunDetail;
window.TimelineRow = TimelineRow;
