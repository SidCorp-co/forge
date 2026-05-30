/* Forge UI Kit — SessionScreen.jsx
   The agent session as a conversation (maps to agent-sessions/:id/turns).
   Full-bleed two-pane: thread + context rail + composer. Content-rich, so it
   fills the viewport — the antidote to sparse centered pages. */

const turnActionStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', cursor: 'pointer',
  padding: 0, fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--fg-subtle)',
};

function PromptTurn({ turn }) {
  return (
    <div style={{ background: 'var(--paper-100)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-lg)', padding: '14px 16px' }}>
      <div className="fg-overline" style={{ marginBottom: 7 }}>{turn.author}</div>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--fg-default)' }}>{turn.text}</p>
    </div>
  );
}

function AgentTurn({ turn }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ width: 30, height: 30, flex: 'none', borderRadius: 'var(--r-md)', background: 'var(--flame-50)',
        border: '1px solid var(--flame-100)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="agent" size={17} style={{ color: 'var(--accent)' }} />
      </span>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg-default)' }}>{turn.author}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)' }}>claude-sonnet</span>
        </div>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--fg-default)' }}>
          {renderInlineCode(turn.text)}
          {turn.streaming && <span className="forge-pulse" style={{ display: 'inline-block', width: 8, height: 16, background: 'var(--accent)', borderRadius: 2, marginLeft: 4, verticalAlign: -3 }} />}
        </p>
        {!turn.streaming && (
          <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
            <button style={turnActionStyle}><Icon name="rerun" size={13} />Regenerate</button>
            <button style={turnActionStyle}><Icon name="fork" size={13} />Fork from here</button>
          </div>
        )}
      </div>
    </div>
  );
}

function renderInlineCode(text) {
  // turn `code` spans into styled mono
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) => p.startsWith('`') && p.endsWith('`')
    ? <code key={i} className="fg-code">{p.slice(1, -1)}</code>
    : <React.Fragment key={i}>{p}</React.Fragment>);
}

const TOOL_ICON = { read: 'folder', edit: 'branch', test: 'check', run: 'cpu' };

function ToolTurn({ turn }) {
  return (
    <div style={{ marginLeft: 42, background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
      borderRadius: 'var(--r-md)', overflow: 'hidden', boxShadow: 'var(--shadow-xs)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px' }}>
        <Icon name={TOOL_ICON[turn.kind] || 'cpu'} size={15} style={{ color: turn.state === 'passed' ? 'var(--green-600)' : 'var(--fg-muted)' }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600, color: 'var(--fg-default)' }}>{turn.title}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5,
          color: turn.state === 'passed' ? 'var(--green-600)' : 'var(--fg-subtle)' }}>{turn.detail}</span>
        {turn.cost && <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)' }}>{turn.cost}</span>}
      </div>
      {turn.diff && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--paper-50)', padding: '8px 12px' }}>
          {turn.diff.map((line, i) => (
            <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.65,
              color: line.startsWith('+') ? 'var(--green-600)' : line.startsWith('-') ? 'var(--red-600)' : 'var(--fg-muted)',
              background: line.startsWith('+') ? 'var(--green-50)' : line.startsWith('-') ? 'var(--red-50)' : 'transparent',
              borderRadius: 3, padding: '0 4px', whiteSpace: 'pre-wrap' }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function VerticalPipeline({ stage, status }) {
  const currentIdx = STAGE_INDEX[stage] ?? 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {STAGES.map((s, i) => {
        const st = i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'todo';
        const last = i === STAGES.length - 1;
        return (
          <div key={s.key} style={{ display: 'flex', gap: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none' }}>
              <span style={{ width: 13, height: 13, borderRadius: 999, flex: 'none',
                background: st === 'done' ? 'var(--green-500)' : st === 'active' ? 'var(--accent)' : 'var(--bg-surface)',
                border: `2px solid ${st === 'done' ? 'var(--green-500)' : st === 'active' ? 'var(--accent)' : 'var(--border-strong)'}`,
                boxShadow: st === 'active' ? '0 0 0 3px var(--flame-100)' : 'none' }} />
              {!last && <span style={{ flex: 1, width: 2, minHeight: 16, background: st === 'done' ? 'var(--green-500)' : 'var(--border-default)' }} />}
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, paddingBottom: 11,
              color: st === 'active' ? 'var(--accent-text)' : st === 'done' ? 'var(--green-600)' : 'var(--fg-subtle)',
              fontWeight: st === 'active' ? 700 : 500 }}>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function SessionScreen({ issue, onBack }) {
  const thread = React.useRef(null);
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
      {/* Header */}
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 14, padding: '13px 22px',
        borderBottom: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}>
        <button onClick={onBack} title="Back to board" style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', cursor: 'pointer', color: 'var(--fg-muted)' }}>
          <Icon name="arrowRight" size={17} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-subtle)' }}>{issue.id}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.title}</span>
        <StatusChip status={issue.status} stage={issue.stage} size="sm" />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button variant="secondary" size="sm" icon="rerun">Rerun</Button>
          <Button variant="secondary" size="sm" icon="fork">Fork</Button>
          <Button variant="danger" size="sm" icon="stop">Stop</Button>
        </div>
      </div>

      {/* Two-pane body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Conversation column */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={thread} style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
            <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
              {SESSION_TURNS.map((t, i) => (
                t.role === 'prompt' ? <PromptTurn key={i} turn={t} />
                  : t.role === 'tool' ? <ToolTurn key={i} turn={t} />
                  : <AgentTurn key={i} turn={t} />
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 42, color: 'var(--fg-subtle)' }}>
                <span className="forge-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }} />
                <span style={{ fontSize: 12.5 }}>Code agent is working…</span>
              </div>
            </div>
          </div>
          {/* Composer */}
          <div style={{ flex: 'none', padding: '14px 28px 18px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}>
            <div style={{ maxWidth: 760, margin: '0 auto' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, padding: '11px 12px 11px 14px',
                border: '1px solid var(--border-strong)', borderRadius: 'var(--r-lg)', background: 'var(--bg-surface)' }}>
                <span style={{ flex: 1, fontSize: 14, color: 'var(--fg-disabled)', paddingBottom: 1 }}>Send a message to the agent — it will fold into the current run…</span>
                <Button variant="primary" size="sm" icon="arrowRight">Send</Button>
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 8, paddingLeft: 2 }}>
                <Stat icon="branch">feat/runner-sweep</Stat>
                <Stat icon="agent">interrupts after current step</Stat>
              </div>
            </div>
          </div>
        </div>

        {/* Context rail */}
        <aside style={{ width: 300, flex: 'none', borderLeft: '1px solid var(--border-default)', background: 'var(--bg-surface)',
          overflowY: 'auto', padding: '20px 20px 24px' }}>
          <div className="fg-overline" style={{ marginBottom: 14 }}>Pipeline</div>
          <VerticalPipeline stage={issue.stage} status={issue.status} />

          <div className="fg-overline" style={{ margin: '22px 0 12px' }}>Run</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <RailStat label="Cost" value={issue.cost} />
            <RailStat label="Tokens" value="48.2k" />
            <RailStat label="Duration" value="1m 04s" />
            <RailStat label="Model" value="claude-sonnet" />
          </div>

          <div className="fg-overline" style={{ margin: '22px 0 12px' }}>Files changed · {SESSION_FILES.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {SESSION_FILES.map(f => (
              <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="folder" size={14} style={{ color: 'var(--fg-subtle)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-default)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{f.path}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--green-600)' }}>+{f.add}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--red-600)' }}>−{f.del}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function RailStat({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{label}</span>
      <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-default)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

window.SessionScreen = SessionScreen;
window.renderInlineCode = renderInlineCode;
