import { Cpu, Github, KeyRound, Layers, Network, Zap } from 'lucide-react';

const features = [
  {
    icon: Cpu,
    title: 'Local-first runner',
    body:
      'Your Claude CLI runs on your machine, on your subscription. Forge orchestrates — never proxies — so credentials never leave your hardware.',
  },
  {
    icon: Layers,
    title: 'Pluggable adapters',
    body:
      'Runner, chat-provider, webhook-source, storage — same shape. Add a new runner or model in one file.',
  },
  {
    icon: Network,
    title: 'MCP-native',
    body:
      'Per-project MCP servers. The desktop and the cloud speak MCP end-to-end. /forge-* skills work everywhere.',
  },
  {
    icon: Zap,
    title: 'Real-time pipeline',
    body:
      'WebSocket events broadcast issue + agent + job state across all UIs. Self-healing classifier recovers stuck pipelines automatically.',
  },
  {
    icon: KeyRound,
    title: 'Open source · Apache-2.0',
    body:
      'Use it commercially, fork it, embed it. No telemetry, no phone-home — observability is opt-in via your own config.',
  },
  {
    icon: Github,
    title: 'Built in public',
    body:
      'Issues, plans, code reviews, every release artifact — all on GitHub. The development pipeline that ships Forge runs on Forge.',
  },
];

export function DownloadFeatures() {
  return (
    <section id="features" className="relative max-w-5xl mx-auto px-6 py-24 border-t border-outline-variant/20">
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
              className="rounded-2xl border border-outline-variant/20 bg-white p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="mb-4 inline-flex w-10 h-10 items-center justify-center rounded-xl bg-warning/10 text-warning">
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
