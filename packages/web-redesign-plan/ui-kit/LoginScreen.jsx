/* Forge UI Kit — LoginScreen.jsx
   Calm, centered sign-in. Brand-forward, lots of whitespace. */

function LoginScreen({ onSignIn }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-app)' }}>
      <div style={{ width: 380 }}>
        {/* Brand */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, marginBottom: 30 }}>
          <img src="../../assets/forge-mark-180.png" alt="Forge" style={{ width: 60, height: 60 }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--ink-900)' }}>Forge</div>
            <div style={{ fontSize: 13.5, color: 'var(--fg-subtle)', marginTop: 2 }}>Control plane for Claude Code</div>
          </div>
        </div>

        {/* Card */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-md)', padding: '26px 26px 24px' }}>
          <h1 style={{ margin: '0 0 4px', fontSize: 19, fontWeight: 700, color: 'var(--ink-900)' }}>Sign in</h1>
          <p style={{ margin: '0 0 20px', fontSize: 13.5, color: 'var(--fg-muted)' }}>Welcome back. Pick up where the pipeline left off.</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            <Field label="Email" value="sid@sidcorp.co" icon="mail" />
            <Field label="Password" value="••••••••••" icon="lock" type="password" />
          </div>

          <button onClick={onSignIn} style={{ width: '100%', marginTop: 18, padding: '11px', background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 'var(--r-md)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 14.5,
            fontWeight: 600, boxShadow: 'var(--shadow-xs)', transition: 'background var(--dur-fast)' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--accent)'}>
            Sign in
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '18px 0' }}>
            <span style={{ flex: 1, height: 1, background: 'var(--border-default)' }} />
            <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', letterSpacing: '0.06em' }}>OR</span>
            <span style={{ flex: 1, height: 1, background: 'var(--border-default)' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <OAuthButton icon="github" label="Continue with GitHub" onClick={onSignIn} />
          </div>
        </div>
        <p style={{ textAlign: 'center', marginTop: 18, fontSize: 12.5, color: 'var(--fg-subtle)' }}>
          New to Forge? <span style={{ color: 'var(--link)', fontWeight: 600, cursor: 'pointer' }}>Create an account</span>
        </p>
      </div>
    </div>
  );
}

function Field({ label, value, icon, type }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-default)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', background: 'var(--bg-surface)',
        border: `1px solid ${focus ? 'var(--cobalt-500)' : 'var(--border-strong)'}`, borderRadius: 'var(--r-md)',
        boxShadow: focus ? 'var(--shadow-focus)' : 'none', transition: 'box-shadow var(--dur-fast), border-color var(--dur-fast)' }}>
        <Icon name={icon} size={16} style={{ color: 'var(--fg-subtle)' }} />
        <input defaultValue={value} type={type === 'password' ? 'password' : 'text'}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-sans)',
            fontSize: 14, color: 'var(--fg-default)' }} />
      </span>
    </label>
  );
}

function OAuthButton({ icon, label, onClick }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '10px',
      background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)', cursor: 'pointer',
      fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600, color: 'var(--fg-default)', transition: 'background var(--dur-fast)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
      onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-surface)'}>
      <Icon name={icon} size={18} style={{ color: 'var(--ink-900)' }} />
      {label}
    </button>
  );
}

window.LoginScreen = LoginScreen;
