/* Forge UI Kit — Primitives.jsx
   Shared atoms: Button, StatusChip, Label, Avatar, Stat, MonoTag. */

const STATUS_META = {
  running: { label: 'Running',  fg: 'var(--cobalt-700)',  bg: 'var(--cobalt-50)',  dot: 'var(--cobalt-500)' },
  review:  { label: 'In review',fg: 'var(--amberw-600)',  bg: 'var(--amberw-50)',  dot: 'var(--amberw-500)' },
  queued:  { label: 'Queued',   fg: 'var(--ink-600)',     bg: 'var(--paper-100)',  dot: 'var(--ink-400)' },
  passed:  { label: 'Passed',   fg: 'var(--green-600)',   bg: 'var(--green-50)',   dot: 'var(--green-500)' },
  done:    { label: 'Done',     fg: 'var(--green-600)',   bg: 'var(--green-50)',   dot: 'var(--green-500)' },
  failed:  { label: 'Failed',   fg: 'var(--red-600)',     bg: 'var(--red-50)',     dot: 'var(--red-500)' },
  blocked: { label: 'Blocked',  fg: 'var(--red-600)',     bg: 'var(--red-50)',     dot: 'var(--red-500)' },
};

const AVATAR_HUE = {
  cobalt: { bg: 'var(--cobalt-100)', fg: 'var(--cobalt-700)' },
  flame:  { bg: 'var(--flame-100)',  fg: 'var(--flame-700)' },
  green:  { bg: 'var(--green-50)',   fg: 'var(--green-600)' },
};

function Button({ variant = 'secondary', size = 'md', icon, children, onClick, style = {}, title }) {
  const base = {
    fontFamily: 'var(--font-sans)', fontWeight: 600, cursor: 'pointer',
    borderRadius: 'var(--r-md)', border: '1px solid transparent',
    display: 'inline-flex', alignItems: 'center', gap: 7, lineHeight: 1,
    transition: 'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
    whiteSpace: 'nowrap',
  };
  const sizes = {
    sm: { fontSize: 13, padding: '6px 11px' },
    md: { fontSize: 14, padding: '9px 15px' },
  };
  const variants = {
    primary:   { background: 'var(--accent)', color: '#fff', boxShadow: 'var(--shadow-xs)' },
    secondary: { background: 'var(--bg-surface)', color: 'var(--fg-default)', borderColor: 'var(--border-strong)' },
    ghost:     { background: 'transparent', color: 'var(--fg-muted)' },
    danger:    { background: 'var(--bg-surface)', color: 'var(--red-600)', borderColor: 'var(--red-500)' },
  };
  const [hover, setHover] = React.useState(false);
  const hoverStyle = hover ? {
    primary:   { background: 'var(--accent-hover)' },
    secondary: { background: 'var(--bg-hover)' },
    ghost:     { background: 'var(--bg-hover)', color: 'var(--fg-default)' },
    danger:    { background: 'var(--red-50)' },
  }[variant] : {};
  return (
    <button title={title} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...base, ...sizes[size], ...variants[variant], ...hoverStyle, ...style }}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 16} />}
      {children}
    </button>
  );
}

function StatusChip({ status, stage, size = 'md' }) {
  const m = STATUS_META[status] || STATUS_META.queued;
  const text = stage && status === 'running' ? `running · ${stage}` : m.label;
  const pad = size === 'sm' ? '3px 8px' : '4px 10px';
  const fs = size === 'sm' ? 11.5 : 12.5;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: fs, fontWeight: 600,
      padding: pad, borderRadius: 'var(--r-pill)', color: m.fg, background: m.bg, whiteSpace: 'nowrap',
      fontFamily: stage && status === 'running' ? 'var(--font-mono)' : 'var(--font-sans)' }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: m.dot,
        boxShadow: status === 'running' ? `0 0 0 3px ${m.bg}` : 'none' }} />
      {text}
    </span>
  );
}

function MonoTag({ children, hue, style = {} }) {
  const hues = {
    cobalt: { color: 'var(--cobalt-700)', background: 'var(--cobalt-50)', borderColor: 'var(--cobalt-100)' },
    flame:  { color: 'var(--flame-700)',  background: 'var(--flame-50)',  borderColor: 'var(--flame-100)' },
  };
  const h = hue ? hues[hue] : { color: 'var(--fg-muted)', background: 'var(--paper-50)', borderColor: 'var(--border-default)' };
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, padding: '2px 7px',
      borderRadius: 'var(--r-sm)', border: '1px solid', ...h, ...style }}>{children}</span>
  );
}

function Avatar({ initials, hue = 'cobalt', size = 24 }) {
  const h = AVATAR_HUE[hue] || AVATAR_HUE.cobalt;
  return (
    <span style={{ width: size, height: size, borderRadius: 999, background: h.bg, color: h.fg,
      fontSize: size * 0.42, fontWeight: 700, display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', flex: 'none', letterSpacing: '0.01em' }}>{initials}</span>
  );
}

function Stat({ icon, children, mono = true, title }) {
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5,
      color: 'var(--fg-subtle)', fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)' }}>
      {icon && <Icon name={icon} size={14} style={{ color: 'var(--fg-subtle)' }} />}
      {children}
    </span>
  );
}

function ProjectMark({ tint, ink, initials, size = 36, radius = 'var(--r-md)' }) {
  return (
    <span style={{ width: size, height: size, flex: 'none', borderRadius: radius, background: tint, color: ink,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)',
      fontSize: size * 0.34, fontWeight: 700, letterSpacing: '0.01em' }}>{initials}</span>
  );
}

const HEALTH_META = {
  healthy:   { label: 'Healthy',   fg: 'var(--green-600)',  dot: 'var(--green-500)',  bg: 'var(--green-50)' },
  attention: { label: 'Attention', fg: 'var(--amberw-600)', dot: 'var(--amberw-500)', bg: 'var(--amberw-50)' },
  down:      { label: 'Down',      fg: 'var(--red-600)',    dot: 'var(--red-500)',    bg: 'var(--red-50)' },
  idle:      { label: 'Idle',      fg: 'var(--ink-600)',    dot: 'var(--ink-400)',    bg: 'var(--paper-100)' },
};

function HealthDot({ health, withLabel = true }) {
  const m = HEALTH_META[health] || HEALTH_META.idle;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600,
      padding: withLabel ? '3px 9px' : 0, borderRadius: 'var(--r-pill)',
      color: m.fg, background: withLabel ? m.bg : 'transparent' }}>
      <span className={health === 'attention' ? 'forge-pulse' : ''} style={{ width: 7, height: 7, borderRadius: 999, background: m.dot }} />
      {withLabel && m.label}
    </span>
  );
}

Object.assign(window, { Button, StatusChip, MonoTag, Avatar, Stat, ProjectMark, HealthDot, HEALTH_META, STATUS_META, AVATAR_HUE });
