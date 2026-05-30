/* Forge UI Kit — App.jsx
   Orchestrates the interactive walkthrough:
   login → board → open issue (run detail) → runners → other tabs. */

function NewIssueModal({ onClose, onCreate }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(24,27,34,0.25)',
        backdropFilter: 'blur(8px)', animation: 'forge-fade var(--dur-base) var(--ease-out)', zIndex: 20 }} />
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 21,
        width: 460, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-xl)',
        boxShadow: 'var(--shadow-lg)', padding: '22px 24px', animation: 'forge-pop var(--dur-base) var(--ease-out)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--ink-900)' }}>New issue</h2>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-subtle)' }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Title</span>
            <input autoFocus placeholder="Describe the change…" style={{ padding: '10px 12px', border: '1px solid var(--border-strong)',
              borderRadius: 'var(--r-md)', fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none' }} />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px', background: 'var(--flame-50)',
            borderRadius: 'var(--r-md)', border: '1px solid var(--flame-100)' }}>
            <Icon name="agent" size={17} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 13, color: 'var(--accent-text)', fontWeight: 500 }}>Triage agent will label and route this into the pipeline.</span>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 20 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="plus" onClick={onCreate}>Create & run</Button>
        </div>
      </div>
    </>
  );
}

const SCREEN_TITLES = { projects: 'Projects', board: 'Board', pipeline: 'Pipeline', sessions: 'Agent sessions', runners: 'Runners', activity: 'Activity', schedules: 'Schedules', skills: 'Skills' };

function NewProjectModal({ onClose, onCreate }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(24,27,34,0.25)',
        backdropFilter: 'blur(8px)', animation: 'forge-fade var(--dur-base) var(--ease-out)', zIndex: 20 }} />
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 21,
        width: 480, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-xl)',
        boxShadow: 'var(--shadow-lg)', padding: '22px 24px', animation: 'forge-pop var(--dur-base) var(--ease-out)' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--ink-900)' }}>New project</h2>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-subtle)' }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Project name</span>
            <input autoFocus placeholder="my-service" style={{ padding: '10px 12px', border: '1px solid var(--border-strong)',
              borderRadius: 'var(--r-md)', fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Repository</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)' }}>
              <Icon name="github" size={16} style={{ color: 'var(--fg-subtle)' }} />
              <span style={{ fontSize: 14, color: 'var(--fg-disabled)' }}>owner/repo</span>
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px', background: 'var(--flame-50)',
            borderRadius: 'var(--r-md)', border: '1px solid var(--flame-100)' }}>
            <Icon name="pipeline" size={17} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 13, color: 'var(--accent-text)', fontWeight: 500 }}>Starts with the default 7-stage pipeline. Pair a device after creating.</span>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 20 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="plus" onClick={onCreate}>Create project</Button>
        </div>
      </div>
    </>
  );
}

function App() {
  const [authed, setAuthed] = React.useState(true);
  const [screen, setScreen] = React.useState('projects');
  const [selected, setSelected] = React.useState(null);
  const [showNew, setShowNew] = React.useState(false);
  const [toast, setToast] = React.useState(null);
  const [palette, setPalette] = React.useState(false);
  const [notifs, setNotifs] = React.useState(false);
  const [sessionIssue, setSessionIssue] = React.useState(null);
  const [openIssue, setOpenIssue] = React.useState(null);
  const [activeProject, setActiveProject] = React.useState(PROJECTS[0]);
  const [showNewProject, setShowNewProject] = React.useState(false);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(null), 2600); }
  function go(s) { setScreen(s); setSelected(null); }

  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function runCommand(c) {
    setPalette(false);
    if (c.nav) go(c.nav);
    else if (c.act === 'new') setShowNew(true);
    else if (c.act === 'open241') { setSelected(null); setSessionIssue(ISSUES[0]); }
  }

  function enterProject(p) { setActiveProject(p); go('board'); }

  if (!authed) return <LoginScreen onSignIn={() => setAuthed(true)} />;
  if (sessionIssue) return <SessionScreen issue={sessionIssue} onBack={() => setSessionIssue(null)} />;
  if (openIssue) return <IssueScreen issue={openIssue} onBack={() => setOpenIssue(null)} onOpenSession={(i) => { setOpenIssue(null); setSessionIssue(i); }} />;

  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--bg-app)' }}>
      <NavRail active={screen} onNav={go} onLogout={() => setAuthed(false)}
        activeProject={activeProject} onSwitchProject={enterProject}
        onAllProjects={() => go('projects')} onNewProject={() => setShowNewProject(true)} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
        <TopBar title={SCREEN_TITLES[screen]} onNewIssue={() => setShowNew(true)}
          onSearch={() => setPalette(true)} onBell={() => setNotifs(n => !n)} />
        <main style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
          {screen === 'projects' && <ProjectsScreen onOpen={enterProject} onNew={() => setShowNewProject(true)} />}
          {screen === 'board' && <BoardScreen onOpen={setOpenIssue} selectedId={selected?.id} />}
          {screen === 'pipeline' && <PipelineScreen onOpen={setOpenIssue} />}
          {screen === 'sessions' && <SessionsListScreen onOpen={(i) => setSessionIssue(i)} onSweep={() => flash('Swept 1 zombie session — runner freed.')} />}
          {screen === 'runners' && <RunnersScreen />}
          {screen === 'activity' && <ActivityScreen onOpen={setOpenIssue} />}
          {screen === 'schedules' && <SchedulesScreen />}
          {screen === 'skills' && <SkillsScreen />}

          {selected && <RunDetail issue={selected} onClose={() => setSelected(null)} onOpenSession={(i) => { setSelected(null); setSessionIssue(i); }} />}
        </main>
      </div>

      {showNew && <NewIssueModal onClose={() => setShowNew(false)} onCreate={() => { setShowNew(false); flash('FRG-242 created — triage agent started.'); }} />}
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreate={() => { setShowNewProject(false); flash('Project created — pair a device to start runners.'); }} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} onRun={runCommand} />}
      {notifs && <NotificationsMenu onClose={() => setNotifs(false)} onOpen={(i) => { setNotifs(false); setOpenIssue(i); }} />}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 30,
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)', borderLeft: '3px solid var(--green-500)', borderRadius: 'var(--r-md)',
          boxShadow: 'var(--shadow-lg)', animation: 'forge-pop var(--dur-base) var(--ease-out)' }}>
          <Icon name="check" size={17} strokeWidth={2.4} style={{ color: 'var(--green-600)' }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-default)' }}>{toast}</span>
        </div>
      )}
    </div>
  );
}

window.App = App;
