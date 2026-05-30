/* Forge UI Kit — PipelineTracker.jsx
   The hero motif. `variant`:
     - 'full'    : labeled beads + connectors (run detail header)
     - 'compact' : small beads, no labels (board rows)
     - 'mini'    : "4 / 7" progress text + thin bar (dense lists) */

function stageState(i, currentIdx, status) {
  if (i < currentIdx) return 'done';
  if (i === currentIdx) {
    if (status === 'failed' || status === 'blocked') return 'error';
    if (status === 'done') return 'done';
    return 'active';
  }
  return 'todo';
}

function Bead({ state, size = 26 }) {
  const ring = size > 18 ? 5 : 3;
  const styles = {
    done:   { background: 'var(--green-500)', border: '2px solid var(--green-500)' },
    active: { background: 'var(--accent)', border: '2px solid var(--accent)', boxShadow: `0 0 0 ${ring}px var(--flame-100)` },
    error:  { background: 'var(--red-500)', border: '2px solid var(--red-500)', boxShadow: `0 0 0 ${ring}px var(--red-50)` },
    todo:   { background: 'var(--bg-surface)', border: '2px solid var(--border-default)' },
  }[state];
  return (
    <span style={{ width: size, height: size, borderRadius: 999, display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center', flex: 'none', ...styles }}>
      {state === 'done' && <Icon name="check" size={size * 0.5} strokeWidth={3} style={{ color: '#fff' }} />}
      {state === 'error' && <Icon name="x" size={size * 0.5} strokeWidth={3} style={{ color: '#fff' }} />}
      {state === 'active' && <span className="forge-pulse" style={{ width: size * 0.34, height: size * 0.34, borderRadius: 999, background: '#fff' }} />}
    </span>
  );
}

function PipelineTracker({ stage, status = 'running', variant = 'full' }) {
  const currentIdx = STAGE_INDEX[stage] ?? 0;

  if (variant === 'mini') {
    const done = status === 'done' ? STAGES.length : currentIdx;
    const pct = (status === 'done' ? STAGES.length : currentIdx + (status === 'running' ? 0.5 : 0)) / STAGES.length * 100;
    const isErr = status === 'failed' || status === 'blocked';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 116 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
          {done} / {STAGES.length}
        </span>
        <div style={{ flex: 1, height: 4, borderRadius: 999, background: 'var(--paper-200)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999,
            background: isErr ? 'var(--red-500)' : status === 'done' ? 'var(--green-500)' : 'var(--accent)' }} />
        </div>
      </div>
    );
  }

  const size = variant === 'compact' ? 16 : 26;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', width: '100%' }}>
      {STAGES.map((s, i) => {
        const st = stageState(i, currentIdx, status);
        const last = i === STAGES.length - 1;
        return (
          <React.Fragment key={s.key}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: variant === 'compact' ? 0 : 8 }}>
              <Bead state={st} size={size} />
              {variant === 'full' && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.02em',
                  color: st === 'active' ? 'var(--accent-text)' : st === 'done' ? 'var(--green-600)' : st === 'error' ? 'var(--red-600)' : 'var(--fg-subtle)',
                  fontWeight: st === 'active' ? 700 : 500 }}>{s.label}</span>
              )}
            </div>
            {!last && (
              <div style={{ flex: 1, height: 2, background: st === 'done' ? 'var(--green-500)' : 'var(--border-default)',
                margin: variant === 'compact' ? '7px 2px 0' : '12px 3px 0' }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

window.PipelineTracker = PipelineTracker;
