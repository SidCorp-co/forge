import { Cpu, Github, KeyRound, Layers, Network, Zap } from 'lucide-react';

// Each feature gets its own accent color so the section reads as a palette
// of intentional choices rather than 6 amber dots scattered on white. Light
// theme M3 surface tokens (info-surface, success-surface) are too pale to
// read as deliberate accents on a white background, so we drive the icon
// chip background with explicit rgba alphas tuned for visibility (~12-15%
// of the saturated brand color). A 1px inset ring carries the matching hue
// at higher opacity to give every chip a defined edge.
const features = [
  {
    icon: Cpu,
    title: 'Local-first runner',
    body:
      'Your Claude CLI runs on your machine, on your subscription. Forge orchestrates — never proxies — so credentials never leave your hardware.',
    iconBg: 'bg-[rgba(245,158,11,0.14)] ring-1 ring-inset ring-warning/30',
    iconColor: 'text-warning-dim',
  },
  {
    icon: Layers,
    title: 'Pluggable adapters',
    body:
      'Runner, chat-provider, webhook-source, storage — same shape. Add a new runner or model in one file.',
    iconBg: 'bg-[rgba(2,132,199,0.12)] ring-1 ring-inset ring-info/30',
    iconColor: 'text-info',
  },
  {
    icon: Network,
    title: 'MCP-native',
    body:
      'Per-project MCP servers. The desktop and the cloud speak MCP end-to-end. /forge-* skills work everywhere.',
    iconBg: 'bg-[rgba(16,185,129,0.14)] ring-1 ring-inset ring-success/30',
    iconColor: 'text-success',
  },
  {
    icon: Zap,
    title: 'Real-time pipeline',
    body:
      'WebSocket events broadcast issue + agent + job state across all UIs. Self-healing classifier recovers stuck pipelines automatically.',
    iconBg: 'bg-[rgba(217,119,6,0.14)] ring-1 ring-inset ring-warning-dim/35',
    iconColor: 'text-warning',
  },
  {
    icon: KeyRound,
    title: 'Open source · Apache-2.0',
    body:
      'Use it commercially, fork it, embed it. No telemetry, no phone-home — observability is opt-in via your own config.',
    iconBg: 'bg-[rgba(124,58,237,0.13)] ring-1 ring-inset ring-[rgba(124,58,237,0.35)]',
    iconColor: 'text-[#7c3aed]',
  },
  {
    icon: Github,
    title: 'Built in public',
    body:
      'Issues, plans, code reviews, every release artifact — all on GitHub. The development pipeline that ships Forge runs on Forge.',
    iconBg: 'bg-[rgba(26,28,28,0.08)] ring-1 ring-inset ring-on-surface/20',
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
              <div
                className={`mb-4 inline-flex w-11 h-11 items-center justify-center rounded-xl ${feature.iconBg} ${feature.iconColor}`}
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
