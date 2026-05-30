/* Forge UI Kit — Shell.jsx
   NavRail (left) + TopBar (top). The fixed workspace chrome. */

function ProjectSwitcher({ activeProject, onSwitchProject, onAllProjects, onNewProject }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const filtered = PROJECTS.filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.repo.toLowerCase().includes(q.toLowerCase()));
  React.useEffect(() => { if (!open) setQ(''); }, [open]);
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px',
        background: open ? 'var(--bg-hover)' : 'var(--paper-50)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)',
        cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
        <ProjectMark tint={activeProject.tint} ink={activeProject.ink} initials={activeProject.key} size={22} radius="var(--r-sm)" />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-default)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeProject.name}</span>
        <Icon name="chevronUpDown" size={15} style={{ color: 'var(--fg-subtle)', marginLeft: 'auto' }} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 31, background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-lg)', padding: 6,
            animation: 'forge-drop var(--dur-base) var(--ease-out)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', marginBottom: 4, borderBottom: '1px solid var(--border-subtle)' }}>
              <Icon name="search" size={14} style={{ color: 'var(--fg-subtle)' }} />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Find a project…"
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-default)', padding: '2px 0' }} />
            </div>
            <div style={{ maxHeight: 248, overflowY: 'auto' }}>
              {filtered.length ? filtered.map(p => {
                const on = p.id === activeProject.id;
                return (
                  <button key={p.id} onClick={() => { onSwitchProject(p); setOpen(false); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px', borderRadius: 'var(--r-sm)',
                      border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', background: on ? 'var(--flame-50)' : 'transparent' }}
                    onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                    <ProjectMark tint={p.tint} ink={p.ink} initials={p.key} size={20} radius="var(--r-sm)" />
                    <span style={{ fontSize: 13, fontWeight: on ? 600 : 500, color: 'var(--fg-default)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    {p.activeRuns > 0 && <span className="forge-pulse" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)', marginLeft: 'auto', flex: 'none' }} />}
                    {on && <Icon name="check" size={15} style={{ color: 'var(--accent)', marginLeft: p.activeRuns > 0 ? 6 : 'auto' }} />}
                  </button>
                );
              }) : <div style={{ padding: '14px 8px', textAlign: 'center', fontSize: 12.5, color: 'var(--fg-subtle)' }}>No matches</div>}
            </div>
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '6px 4px' }} />
            <button onClick={() => { onAllProjects(); setOpen(false); }} style={menuItemStyle}>
              <Icon name="folder" size={16} style={{ color: 'var(--fg-subtle)' }} />All projects
            </button>
            <button onClick={() => { onNewProject(); setOpen(false); }} style={menuItemStyle}>
              <Icon name="plus" size={16} style={{ color: 'var(--fg-subtle)' }} />New project
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const menuItemStyle = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px', borderRadius: 'var(--r-sm)',
  border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, color: 'var(--fg-default)', background: 'transparent',
};

function NavItem({ item, active, onNav }) {
  const on = active === item.key;
  return (
    <button onClick={() => onNav(item.key)}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: '7px 10px',
        marginBottom: 1, borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer',
        fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: on ? 600 : 500,
        background: on ? 'var(--flame-50)' : 'transparent',
        color: on ? 'var(--accent-text)' : 'var(--fg-muted)',
        transition: 'background var(--dur-fast) var(--ease-out)' }}
      onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
      <Icon name={item.icon} size={18} style={{ color: on ? 'var(--accent)' : 'var(--fg-subtle)' }} />
      <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
      {item.badge != null && item.badge > 0 && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
          color: on ? 'var(--accent-text)' : 'var(--fg-subtle)' }}>{item.badge}</span>
      )}
    </button>
  );
}

function NavGroupLabel({ children }) {
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
      color: 'var(--fg-subtle)', fontWeight: 600, padding: '0 10px', margin: '2px 0 7px' }}>{children}</div>
  );
}

function NavRail({ active, onNav, onLogout, activeProject, onSwitchProject, onAllProjects, onNewProject }) {
  // light contextual counts on workspace items
  const wsItems = NAV_WORKSPACE.map(i =>
    i.key === 'projects' ? { ...i, badge: PROJECTS.length } :
    i.key === 'runners'  ? { ...i, badge: DEVICES.reduce((n, d) => n + d.runners.length, 0) } : i);
  const projItems = NAV_PROJECT.map(i =>
    i.key === 'sessions' ? { ...i, badge: QUEUE_STATS.active } :
    i.key === 'board'    ? { ...i, badge: activeProject.openIssues } : i);

  return (
    <nav style={{ width: 236, flex: 'none', background: 'var(--bg-surface)', borderRight: '1px solid var(--border-default)',
      display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '16px 18px 14px' }}>
        <img src="../../assets/forge-mark-180.png" alt="Forge" style={{ width: 26, height: 26 }} />
        <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--ink-900)' }}>Forge</span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--fg-subtle)', fontWeight: 600 }}>SidCorp</span>
      </div>

      <div style={{ flex: 1, overflowY: 'visible', padding: '4px 10px 8px' }}>
        {/* Workspace tier */}
        <NavGroupLabel>Workspace</NavGroupLabel>
        {wsItems.map(item => <NavItem key={item.key} item={item} active={active} onNav={onNav} />)}

        {/* Project tier — switcher gates the scoped items */}
        <div style={{ margin: '16px 0 9px' }}>
          <NavGroupLabel>Project</NavGroupLabel>
          <div style={{ padding: '0 2px' }}>
            <ProjectSwitcher activeProject={activeProject} onSwitchProject={onSwitchProject} onAllProjects={onAllProjects} onNewProject={onNewProject} />
          </div>
        </div>
        {projItems.map(item => <NavItem key={item.key} item={item} active={active} onNav={onNav} />)}
      </div>

      {/* Device status + user footer */}
      <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border-subtle)' }}>
        <button onClick={() => onNav('runners')} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 'var(--r-md)',
          background: 'var(--paper-50)', border: '1px solid var(--border-subtle)', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--green-500)', boxShadow: '0 0 0 3px var(--green-50)' }} />
          <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>2 devices online</span>
          <Icon name="monitor" size={15} style={{ color: 'var(--fg-subtle)', marginLeft: 'auto' }} />
        </button>
        <button onClick={onLogout} style={{ width: '100%', marginTop: 8, display: 'flex', alignItems: 'center', gap: 9,
          padding: '7px 10px', background: 'transparent', border: 'none', borderRadius: 'var(--r-sm)', cursor: 'pointer',
          fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-subtle)' }}>
          <Avatar initials="SK" hue="cobalt" size={22} />
          <span style={{ fontWeight: 600, color: 'var(--fg-muted)' }}>Sid Kumar</span>
          <Icon name="settings" size={15} style={{ marginLeft: 'auto', color: 'var(--fg-subtle)' }} />
        </button>
      </div>
    </nav>
  );
}

function TopBar({ title, onNewIssue, onSearch, onBell }) {
  return (
    <header style={{ height: 60, flex: 'none', borderBottom: '1px solid var(--border-default)', background: 'var(--bg-surface)',
      display: 'flex', alignItems: 'center', gap: 16, padding: '0 22px' }}>
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink-900)', whiteSpace: 'nowrap' }}>{title}</h1>
      <div style={{ flex: 1 }} />
      <button onClick={onSearch} style={{ display: 'flex', alignItems: 'center', gap: 8, width: 280, padding: '8px 12px',
        background: 'var(--paper-50)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', cursor: 'pointer' }}>
        <Icon name="search" size={16} style={{ color: 'var(--fg-subtle)' }} />
        <span style={{ fontSize: 13.5, color: 'var(--fg-disabled)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Search issues, runs…</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)',
          border: '1px solid var(--border-default)', borderRadius: 4, padding: '1px 5px' }}>⌘K</span>
      </button>
      <button title="Notifications" onClick={onBell} style={{ position: 'relative', width: 38, height: 38, display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'transparent', border: '1px solid var(--border-default)',
        borderRadius: 'var(--r-md)', cursor: 'pointer', color: 'var(--fg-muted)' }}>
        <Icon name="bell" size={18} />
        <span style={{ position: 'absolute', top: 7, right: 8, width: 7, height: 7, borderRadius: 999,
          background: 'var(--accent)', border: '1.5px solid var(--bg-surface)' }} />
      </button>
      <Button variant="primary" icon="plus" onClick={onNewIssue}>New issue</Button>
    </header>
  );
}

Object.assign(window, { NavRail, TopBar });
