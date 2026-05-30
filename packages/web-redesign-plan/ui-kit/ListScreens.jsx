/* Forge UI Kit — ListScreens.jsx
   ActivityScreen · SkillsScreen · SchedulesScreen.
   Three calm list views that round out the prototype. */

const HUE_DOT = { flame: 'var(--accent)', green: 'var(--green-500)', amber: 'var(--amberw-500)', cobalt: 'var(--cobalt-500)', red: 'var(--red-500)' };

/* ---------- Activity feed ---------- */
function ActivityScreen({ onOpen }) {
  const stageCounts = STAGES.map(s => ({ ...s, n: ACTIVITY.filter(a => a.stage === s.key).length }));
  return (
    <div style={{ padding: '22px 26px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span className="forge-pulse" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--accent)' }} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg-muted)' }}>Live across all projects</span>
        <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--fg-subtle)' }}>Broadcasting over WebSocket</span>
      </div>
      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
          {ACTIVITY.map((a, i) => (
            <button key={i} onClick={() => onOpen(ISSUES.find(x => x.id === a.id) || ISSUES[0])}
              style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13, padding: '13px 18px',
                background: 'transparent', border: 'none', borderBottom: i < ACTIVITY.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                cursor: 'pointer', fontFamily: 'var(--font-sans)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <span style={{ width: 9, height: 9, borderRadius: 999, flex: 'none', background: HUE_DOT[a.hue] }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-subtle)', width: 56, flex: 'none' }}>{a.id}</span>
              <span style={{ fontSize: 13.5, color: 'var(--fg-default)', minWidth: 0, flex: 1 }}>
                <strong style={{ fontWeight: 600 }}>{a.agent}</strong> {a.verb}{' '}
                <span style={{ color: 'var(--fg-muted)' }}>{a.detail}</span>
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-subtle)', flex: 'none' }}>{a.time}</span>
            </button>
          ))}
        </div>
        {/* Context rail */}
        <aside style={{ width: 280, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-sm)', padding: '15px 16px' }}>
            <div className="fg-overline" style={{ marginBottom: 12 }}>Today</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <RailRow label="Events" value={ACTIVITY.length} />
              <RailRow label="Runs completed" value="6" />
              <RailRow label="Spent" value="$5.81" />
              <RailRow label="Median step" value="12s" />
            </div>
          </div>
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-sm)', padding: '15px 16px' }}>
            <div className="fg-overline" style={{ marginBottom: 12 }}>By stage</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {stageCounts.map(s => (
                <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: s.color }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-muted)' }}>{s.label}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: s.n ? 'var(--fg-default)' : 'var(--fg-disabled)' }}>{s.n}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function RailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{label}</span>
      <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--fg-default)' }}>{value}</span>
    </div>
  );
}

/* ---------- Skill registry ---------- */
function SkillsScreen() {
  return (
    <div style={{ padding: '22px 26px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-muted)', maxWidth: 560 }}>
          Shared agent skills, synced across projects with per-stage overrides.
        </p>
        <Button variant="primary" icon="plus" style={{ marginLeft: 'auto' }}>New skill</Button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px,1fr))', gap: 14 }}>
        {SKILLS.map(s => {
          const stage = STAGES.find(st => st.key === s.stage);
          return (
            <div key={s.name} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
              borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-sm)', padding: '15px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                <Icon name="agent" size={16} style={{ color: stage ? stage.color : 'var(--fg-muted)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--fg-default)' }}>{s.name}</span>
                <span title={s.synced ? 'Synced' : 'Out of sync'} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5,
                  fontSize: 11.5, fontWeight: 600, color: s.synced ? 'var(--green-600)' : 'var(--amberw-600)' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: s.synced ? 'var(--green-500)' : 'var(--amberw-500)' }} />
                  {s.synced ? 'synced' : 'drift'}
                </span>
              </div>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.45 }}>{s.desc}</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <MonoTag>{s.stage}</MonoTag>
                <MonoTag style={{ borderColor: 'var(--border-subtle)' }}>{s.scope}</MonoTag>
                <Stat icon="activity" style={{ marginLeft: 'auto' }}>{s.uses}</Stat>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Schedules ---------- */
function SchedulesScreen() {
  const lastMeta = { passed: { c: 'var(--green-600)', d: 'var(--green-500)' }, failed: { c: 'var(--red-600)', d: 'var(--red-500)' }, paused: { c: 'var(--fg-muted)', d: 'var(--ink-400)' } };
  return (
    <div style={{ padding: '22px 26px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-muted)' }}>Run pipelines on a cadence.</p>
        <Button variant="primary" icon="plus" style={{ marginLeft: 'auto' }}>New schedule</Button>
      </div>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
        {SCHEDULES.map((s, i) => {
          const lm = lastMeta[s.last];
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '44px minmax(0,1fr) 170px 120px 84px', alignItems: 'center', gap: 14,
              padding: '14px 18px', borderBottom: i < SCHEDULES.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
              <Toggle on={s.enabled} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: s.enabled ? 'var(--fg-default)' : 'var(--fg-subtle)' }}>{s.name}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>{s.target}</div>
              </div>
              <Stat icon="clock">{s.cadence}</Stat>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: lm.c }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: lm.d }} />{s.last}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'right' }}>{s.enabled ? s.next : '—'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Toggle({ on: initial }) {
  const [on, setOn] = React.useState(initial);
  return (
    <button onClick={() => setOn(o => !o)} style={{ width: 36, height: 21, borderRadius: 999, border: 'none', cursor: 'pointer',
      background: on ? 'var(--accent)' : 'var(--paper-300)', padding: 2, transition: 'background var(--dur-base) var(--ease-out)' }}>
      <span style={{ display: 'block', width: 17, height: 17, borderRadius: 999, background: '#fff', boxShadow: 'var(--shadow-sm)',
        transform: on ? 'translateX(15px)' : 'translateX(0)', transition: 'transform var(--dur-base) var(--ease-out)' }} />
    </button>
  );
}

Object.assign(window, { ActivityScreen, SkillsScreen, SchedulesScreen, Toggle });
