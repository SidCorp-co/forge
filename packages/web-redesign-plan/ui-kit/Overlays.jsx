/* Forge UI Kit — Overlays.jsx
   CommandPalette (⌘K) + NotificationsMenu. */

function CommandPalette({ onClose, onRun }) {
  const [q, setQ] = React.useState('');
  const [active, setActive] = React.useState(0);
  const results = COMMANDS.filter(c => c.label.toLowerCase().includes(q.toLowerCase()));

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) onRun(results[active]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [results, active, onClose, onRun]);

  React.useEffect(() => { setActive(0); }, [q]);

  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(24,27,34,0.25)',
        backdropFilter: 'blur(8px)', animation: 'forge-fade var(--dur-base) var(--ease-out)', zIndex: 40 }} />
      <div style={{ position: 'absolute', top: 90, left: '50%', transform: 'translateX(-50%)', zIndex: 41, width: 540,
        background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-xl)',
        boxShadow: 'var(--shadow-lg)', overflow: 'hidden', animation: 'forge-drop var(--dur-base) var(--ease-out)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
          <Icon name="search" size={18} style={{ color: 'var(--fg-subtle)' }} />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search or run a command…"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-sans)',
              fontSize: 15, color: 'var(--fg-default)' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '1px 6px' }}>esc</span>
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto', padding: 7 }}>
          {results.length ? results.map((c, i) => (
            <button key={i} onMouseEnter={() => setActive(i)} onClick={() => onRun(c)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 11px', borderRadius: 'var(--r-sm)',
                border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)',
                background: i === active ? 'var(--flame-50)' : 'transparent' }}>
              <Icon name={c.icon} size={17} style={{ color: i === active ? 'var(--accent)' : 'var(--fg-subtle)' }} />
              <span style={{ fontSize: 14, color: 'var(--fg-default)', flex: 1 }}>{c.label}</span>
              {c.kbd && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)' }}>{c.kbd}</span>}
            </button>
          )) : (
            <div style={{ padding: '22px', textAlign: 'center', fontSize: 13.5, color: 'var(--fg-subtle)' }}>No matches</div>
          )}
        </div>
      </div>
    </>
  );
}

function NotificationsMenu({ onClose, onOpen }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 35 }} />
      <div style={{ position: 'absolute', top: 56, right: 22, zIndex: 36, width: 340, background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-lg)',
        overflow: 'hidden', animation: 'forge-drop var(--dur-base) var(--ease-out)' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '13px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink-900)' }}>Notifications</span>
          <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--link)', fontWeight: 600, cursor: 'pointer' }}>Mark all read</span>
        </div>
        <div>
          {NOTIFICATIONS.map((n, i) => (
            <button key={i} onClick={() => { onOpen(ISSUES.find(x => x.id === n.id) || ISSUES[0]); onClose(); }}
              style={{ width: '100%', textAlign: 'left', display: 'flex', gap: 11, padding: '12px 16px', border: 'none',
                borderBottom: i < NOTIFICATIONS.length - 1 ? '1px solid var(--border-subtle)' : 'none', cursor: 'pointer',
                background: n.unread ? 'var(--flame-50)' : 'transparent', fontFamily: 'var(--font-sans)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = n.unread ? 'var(--flame-50)' : 'transparent'}>
              <span style={{ width: 8, height: 8, borderRadius: 999, flex: 'none', marginTop: 5,
                background: { amber: 'var(--amberw-500)', red: 'var(--red-500)', green: 'var(--green-500)' }[n.hue] }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-default)' }}>{n.text}</div>
                <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 1 }}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{n.id}</span> · {n.sub}
                </div>
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)', flex: 'none' }}>{n.time}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

Object.assign(window, { CommandPalette, NotificationsMenu });
