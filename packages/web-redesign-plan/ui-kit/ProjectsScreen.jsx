/* Forge UI Kit — ProjectsScreen.jsx
   Workspace projects console (GET /api/projects + /api/projects/health).
   Built for MANY projects on one account: search, sort, Cards/List views,
   pinned projects, and a needs-attention section. Click → enter a project. */

const HEALTH_RANK = { down: 0, attention: 1, healthy: 2, idle: 3 };

function MemberStack({ members, size = 24 }) {
  return (
    <div style={{ display: 'flex' }}>
      {members.map((m, i) => (
        <span key={i} style={{ marginLeft: i ? -7 : 0, borderRadius: 999, boxShadow: '0 0 0 2px var(--bg-surface)' }}>
          <Avatar initials={m} hue={['cobalt', 'flame', 'green'][i % 3]} size={size} />
        </span>
      ))}
    </div>
  );
}

function LiveCount({ n }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontFamily: 'var(--font-mono)',
      color: n ? 'var(--accent-text)' : 'var(--fg-subtle)' }}>
      {n > 0 && <span className="forge-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }} />}
      {n} live
    </span>
  );
}

/* ---------- Card view ---------- */
function ProjectCard({ project, onOpen }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onClick={() => onOpen(project)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 13, padding: '16px 17px',
        background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)',
        cursor: 'pointer', boxShadow: hover ? 'var(--shadow-md)' : 'var(--shadow-sm)', opacity: project.archived ? 0.7 : 1,
        transform: hover ? 'translateY(-2px)' : 'none', transition: 'box-shadow var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out)',
        fontFamily: 'var(--font-sans)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <ProjectMark tint={project.tint} ink={project.ink} initials={project.key} size={38} radius="var(--r-md)" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--fg-default)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.name}</span>
            {project.pinned && <Icon name="star" size={12} style={{ color: 'var(--amberw-500)', flex: 'none' }} />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, color: 'var(--fg-subtle)' }}>
            <Icon name="github" size={12} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.repo}</span>
          </div>
        </div>
        <HealthDot health={project.health} withLabel={false} />
      </div>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.45, minHeight: 19, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.desc}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
        <LiveCount n={project.activeRuns} />
        <Stat icon="inbox">{project.openIssues}</Stat>
        <Stat icon="server">{project.runners}</Stat>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <MemberStack members={project.members} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)' }}>{project.updated}</span>
        </span>
      </div>
    </button>
  );
}

/* ---------- List view ---------- */
const LIST_COLS = '34px minmax(0,1.6fr) minmax(0,1fr) 96px 78px 64px 64px 96px 64px';
function ProjectRow({ project, onOpen, last }) {
  return (
    <div onClick={() => onOpen(project)}
      style={{ display: 'grid', gridTemplateColumns: LIST_COLS, gap: 14, alignItems: 'center', padding: '11px 16px',
        borderBottom: last ? 'none' : '1px solid var(--border-subtle)', cursor: 'pointer', opacity: project.archived ? 0.7 : 1 }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
      <ProjectMark tint={project.tint} ink={project.ink} initials={project.key} size={30} radius="var(--r-sm)" />
      <span style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13.5, fontWeight: 600, color: 'var(--fg-default)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
        {project.pinned && <Icon name="star" size={11} style={{ color: 'var(--amberw-500)', flex: 'none' }} />}
      </span>
      <span style={{ fontSize: 13, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.desc}</span>
      <HealthDot health={project.health} />
      <LiveCount n={project.activeRuns} />
      <Stat icon="inbox">{project.openIssues}</Stat>
      <Stat icon="server">{project.runners}</Stat>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'right' }}>{project.spend}</span>
      <span style={{ justifySelf: 'end' }}><MemberStack members={project.members} size={22} /></span>
    </div>
  );
}

function ListTable({ items, onOpen }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: LIST_COLS, gap: 14, padding: '9px 16px', borderBottom: '1px solid var(--border-default)', background: 'var(--paper-50)' }}>
        {['', 'Project', 'Description', 'Health', 'Runs', 'Issues', 'Runners', 'Spend', 'Team'].map((h, i) => (
          <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--fg-subtle)', textAlign: i === 7 ? 'right' : i === 8 ? 'right' : 'left' }}>{h}</span>
        ))}
      </div>
      {items.map((p, i) => <ProjectRow key={p.id} project={p} onOpen={onOpen} last={i === items.length - 1} />)}
    </div>
  );
}

/* ---------- New project tile ---------- */
function NewProjectTile({ onNew }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onClick={onNew} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
        minHeight: 156, background: hover ? 'var(--flame-50)' : 'transparent', cursor: 'pointer',
        border: `1.5px dashed ${hover ? 'var(--flame-300)' : 'var(--border-strong)'}`, borderRadius: 'var(--r-lg)',
        color: hover ? 'var(--accent-text)' : 'var(--fg-muted)', fontFamily: 'var(--font-sans)',
        transition: 'background var(--dur-fast), border-color var(--dur-fast), color var(--dur-fast)' }}>
      <span style={{ width: 38, height: 38, borderRadius: 'var(--r-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: hover ? 'var(--bg-surface)' : 'var(--paper-100)' }}>
        <Icon name="plus" size={22} style={{ color: hover ? 'var(--accent)' : 'var(--fg-subtle)' }} />
      </span>
      <span style={{ fontSize: 14, fontWeight: 600 }}>New project</span>
    </button>
  );
}

/* ---------- Toolbar controls ---------- */
function ViewToggle({ view, onChange }) {
  return (
    <div style={{ display: 'flex', background: 'var(--paper-100)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', padding: 2 }}>
      {[['cards', 'grid'], ['list', 'rows']].map(([v, ic]) => (
        <button key={v} onClick={() => onChange(v)} title={v === 'cards' ? 'Cards' : 'List'}
          style={{ width: 34, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: 'none',
            borderRadius: 'var(--r-sm)', background: view === v ? 'var(--bg-surface)' : 'transparent',
            boxShadow: view === v ? 'var(--shadow-xs)' : 'none', color: view === v ? 'var(--fg-default)' : 'var(--fg-subtle)' }}>
          <Icon name={ic} size={16} />
        </button>
      ))}
    </div>
  );
}

function SectionLabel({ icon, children, count, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 2px 12px' }}>
      {icon && <Icon name={icon} size={15} style={{ color: color || 'var(--fg-subtle)' }} />}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-muted)', fontWeight: 600 }}>{children}</span>
      {count != null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)' }}>{count}</span>}
    </div>
  );
}

function ProjectsScreen({ onOpen, onNew }) {
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState('recent');
  const [view, setView] = React.useState('cards');
  const [focusSearch, setFocusSearch] = React.useState(false);
  const [attentionOnly, setAttentionOnly] = React.useState(false);

  const totals = PROJECTS.reduce((a, p) => ({ runs: a.runs + p.activeRuns, issues: a.issues + p.openIssues, runners: a.runners + p.runners }), { runs: 0, issues: 0, runners: 0 });
  const attentionCount = PROJECTS.filter(p => ['down', 'attention'].includes(p.health)).length;

  let list = PROJECTS.filter(p => {
    const q = query.toLowerCase();
    const matches = !q || p.name.toLowerCase().includes(q) || p.repo.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q);
    return matches && (!attentionOnly || ['down', 'attention'].includes(p.health));
  });
  list = [...list].sort((a, b) =>
    sort === 'name' ? a.name.localeCompare(b.name) :
    sort === 'attention' ? (HEALTH_RANK[a.health] - HEALTH_RANK[b.health]) || (a.mins - b.mins) :
    a.mins - b.mins);

  const searching = query || attentionOnly || sort !== 'recent';
  const pinned = list.filter(p => p.pinned);
  const rest = searching ? list : list.filter(p => !p.pinned);

  const renderGroup = (items) => view === 'list'
    ? <ListTable items={items} onOpen={onOpen} />
    : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(326px, 1fr))', gap: 14 }}>{items.map(p => <ProjectCard key={p.id} project={p} onOpen={onOpen} />)}</div>;

  return (
    <div style={{ padding: '22px 26px', maxWidth: 1240, margin: '0 auto' }}>
      {/* Workspace summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, padding: '13px 18px',
        background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-xs)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink-900)' }}>SidCorp workspace</span>
        <span style={{ width: 1, height: 16, background: 'var(--border-default)' }} />
        <Stat icon="folder">{PROJECTS.length} projects</Stat>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--accent-text)' }}>
          <span className="forge-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }} />{totals.runs} live
        </span>
        <Stat icon="inbox">{totals.issues} open</Stat>
        <Stat icon="server">{totals.runners} runners</Stat>
        <Stat icon="dollar">13.38 today</Stat>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 220, maxWidth: 380, padding: '8px 12px',
          background: 'var(--bg-surface)', border: `1px solid ${focusSearch ? 'var(--cobalt-500)' : 'var(--border-default)'}`,
          borderRadius: 'var(--r-md)', boxShadow: focusSearch ? 'var(--shadow-focus)' : 'none' }}>
          <Icon name="search" size={16} style={{ color: 'var(--fg-subtle)' }} />
          <input value={query} onChange={e => setQuery(e.target.value)} onFocus={() => setFocusSearch(true)} onBlur={() => setFocusSearch(false)}
            placeholder="Search projects…" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--fg-default)' }} />
        </div>
        <select value={sort} onChange={e => setSort(e.target.value)}
          style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 500, color: 'var(--fg-default)', padding: '8px 12px',
            background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', cursor: 'pointer' }}>
          <option value="recent">Recently active</option>
          <option value="name">Name (A–Z)</option>
          <option value="attention">Health</option>
        </select>
        <ViewToggle view={view} onChange={setView} />
        <Button variant="primary" icon="plus" onClick={onNew} style={{ marginLeft: 'auto' }}>New project</Button>
      </div>

      {/* Attention banner */}
      {attentionCount > 0 && (
        <button onClick={() => setAttentionOnly(a => !a)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: '11px 16px', marginBottom: 16, cursor: 'pointer',
            textAlign: 'left', background: attentionOnly ? 'var(--amberw-50)' : 'var(--bg-surface)', fontFamily: 'var(--font-sans)',
            border: `1px solid ${attentionOnly ? 'var(--amberw-500)' : 'var(--border-default)'}`, borderRadius: 'var(--r-md)' }}>
          <Icon name="alert" size={17} style={{ color: 'var(--amberw-600)' }} />
          <span style={{ fontSize: 13.5, color: 'var(--fg-default)' }}>
            <strong style={{ fontWeight: 600 }}>{attentionCount} projects</strong> need attention — blocked runs or offline runners.
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: 'var(--amberw-600)' }}>{attentionOnly ? 'Show all' : 'Show only these'}</span>
        </button>
      )}

      {/* Pinned (only when not searching/filtering) */}
      {!searching && pinned.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <SectionLabel icon="star" color="var(--amberw-500)" count={pinned.length}>Pinned</SectionLabel>
          {renderGroup(pinned)}
        </div>
      )}

      {/* All / results */}
      {!searching && <SectionLabel icon="folder" count={rest.length}>All projects</SectionLabel>}
      {rest.length > 0 ? renderGroup(rest) : (
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13.5 }}>No projects match “{query}”.</div>
      )}

      {/* New tile (cards view, unfiltered only) */}
      {view === 'cards' && !searching && (
        <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(326px, 1fr))', gap: 14 }}>
          <NewProjectTile onNew={onNew} />
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ProjectsScreen });
