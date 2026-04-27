import { Cpu, Github, KeyRound, Layers, Network, Zap } from 'lucide-react';

// Each feature gets its own accent color so the section reads as a palette
// of intentional choices rather than 6 amber dots scattered on white. Colors
// stay within the existing M3 token vocabulary (warning · success · info ·
// error · primary) so we don't drift from the theme.
const features = [
  {
    icon: Cpu,
    title: 'Local-first runner',
    body:
      'Your Claude CLI runs on your machine, on your subscription. Forge orchestrates — never proxies — so credentials never leave your hardware.',
    iconBg: 'bg-warning/10',
    iconColor: 'text-warning',
  },
  {
    icon: Layers,
    title: 'Pluggable adapters',
    body:
      'Runner, chat-provider, webhook-source, storage — same shape. Add a new runner or model in one file.',
    iconBg: 'bg-info-surface',
    iconColor: 'text-info',
  },
  {
    icon: Network,
    title: 'MCP-native',
    body:
      'Per-project MCP servers. The desktop and the cloud speak MCP end-to-end. /forge-* skills work everywhere.',
    iconBg: 'bg-success-surface',
    iconColor: 'text-success',
  },
  {
    icon: Zap,
    title: 'Real-time pipeline',
    body:
      'WebSocket events broadcast issue + agent + job state across all UIs. Self-healing classifier recovers stuck pipelines automatically.',
    iconBg: 'bg-warning/10',
    iconColor: 'text-warning-dim',
  },
  {
    icon: KeyRound,
    title: 'Open source · Apache-2.0',
    body:
      'Use it commercially, fork it, embed it. No telemetry, no phone-home — observability is opt-in via your own config.',
    iconBg: 'bg-info-surface',
    iconColor: 'text-info-dim',
  },
  {
    icon: Github,
    title: 'Built in public',
    body:
      'Issues, plans, code reviews, every release artifact — all on GitHub. The development pipeline that ships Forge runs on Forge.',
    iconBg: 'bg-surface-container',
    iconColor: 'text-on-surface',
  },
];

export function DownloadFeatures() {
  return (
    <section
      id="features"
      className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-24 border-t border-outline-variant/20"
    >
      <div className="pointer-events-none absolute -top-20 right-[-10%] w-[400px] h-[400px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.04)_0%,transparent_70%)]" />

      <div className="text-center mb-14">
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Why Forge
        </p>
        <h2 className="font-serif text-3xl sm:text-4xl md:text-5xl tracking-tight mb-3">
          Built for{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            AI-assisted developers
          </span>
        </h2>
        <p className="text-primary-fixed max-w-xl mx-auto text-base font-light leading-relaxed">
          A control plane that respects your stack. Bring your own runners,
          your own models, your own infrastructure — Forge handles the
          orchestration.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => {
          const Icon = feature.icon;
          return (
            <div
              key={feature.title}
              className="group relative rounded-2xl border border-outline-variant/30 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] hover:border-outline-variant/60"
            >
              {/* Subtle top-edge accent that matches the icon color — gives
                  every card a tiny chromatic identity instead of 6 white blocks. */}
              <div
                aria-hidden
                className={`absolute inset-x-6 -top-px h-px ${feature.iconBg} opacity-0 group-hover:opacity-100 transition-opacity`}
              />
              <div
                className={`mb-4 inline-flex w-10 h-10 items-center justify-center rounded-xl ${feature.iconBg} ${feature.iconColor}`}
              >
                <Icon className="w-5 h-5" />
              </div>
              <h3 className="mb-2 font-medium text-on-surface">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-primary-fixed font-light">
                {feature.body}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
