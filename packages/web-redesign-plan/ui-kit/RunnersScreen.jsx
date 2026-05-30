/* Forge UI Kit — RunnersScreen.jsx
   Devices & runners — the real-time, multi-device surface. One device can run
   runners for several projects at once. */

function RunnerStatusDot({ status }) {
  const c = { busy: 'var(--accent)', idle: 'var(--green-500)', offline: 'var(--ink-400)' }[status];
  return <span className={status === 'busy' ? 'forge-pulse' : ''} style={{ width: 8, height: 8, borderRadius: 999, background: c, flex: 'none' }} />;
}

function DeviceCard({ device }) {
  const online = device.status === 'online';
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)',
      boxShadow: 'var(--shadow-sm)', overflow: 'hidden', opacity: online ? 1 : 0.72 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ width: 38, height: 38, borderRadius: 'var(--r-md)', flex: 'none', display: 'flex', alignItems: 'center',
          justifyContent: 'center', background: 'var(--paper-100)', color: 'var(--fg-muted)' }}>
          <Icon name="monitor" size={20} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13.5, fontWeight: 600, color: 'var(--fg-default)', whiteSpace: 'nowrap' }}>{device.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{device.os}</div>
        </div>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600,
          padding: '4px 10px', borderRadius: 'var(--r-pill)',
          background: online ? 'var(--green-50)' : 'var(--paper-100)', color: online ? 'var(--green-600)' : 'var(--fg-muted)' }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: online ? 'var(--green-500)' : 'var(--ink-400)' }} />
          {online ? 'Online' : 'Offline'}
        </span>
      </div>
      <div style={{ padding: '6px 8px' }}>
        {device.runners.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 10px', borderRadius: 'var(--r-sm)' }}>
            <RunnerStatusDot status={r.status} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--fg-default)' }}>{r.project}</span>
            <MonoTag style={{ borderColor: 'var(--border-subtle)' }}>{r.model}</MonoTag>
            <span style={{ marginLeft: 'auto', fontSize: 12.5, color: r.job ? 'var(--accent-text)' : 'var(--fg-subtle)',
              fontFamily: r.job ? 'var(--font-mono)' : 'var(--font-sans)' }}>
              {r.job || (r.status === 'offline' ? 'disconnected' : 'idle')}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderTop: '1px solid var(--border-subtle)', background: 'var(--paper-50)' }}>
        <Stat icon="cpu">Claude quota {device.quota}</Stat>
        <Button variant="ghost" size="sm" icon="more" style={{ marginLeft: 'auto', padding: '5px 8px' }} />
      </div>
    </div>
  );
}

function RunnersScreen() {
  return (
    <div style={{ padding: '22px 26px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 18 }}>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-muted)', maxWidth: 560, lineHeight: 1.5 }}>
          Each device runs runners for one or more projects. Changes broadcast instantly over WebSocket — this view is live.
        </p>
        <Button variant="primary" icon="plus" style={{ marginLeft: 'auto' }}>Pair a device</Button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
        {DEVICES.map(d => <DeviceCard key={d.name} device={d} />)}
      </div>
    </div>
  );
}

function PlaceholderScreen({ title, icon, line }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, color: 'var(--fg-subtle)' }}>
      <span style={{ width: 56, height: 56, borderRadius: 'var(--r-lg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--paper-100)', color: 'var(--fg-muted)' }}><Icon name={icon} size={26} /></span>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-default)' }}>{title}</div>
      <div style={{ fontSize: 13.5, maxWidth: 320, textAlign: 'center', lineHeight: 1.5 }}>{line}</div>
    </div>
  );
}

Object.assign(window, { RunnersScreen, PlaceholderScreen });
