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
      'Runner, chat-provider, webhook-source, storage all share the same adapter shape. Add a new runner or model in one file.',
  },
  {
    icon: Network,
    title: 'MCP-native',
    body:
      'Per-project MCP server config. The desktop app speaks MCP to Claude CLI; the cloud server speaks MCP to /forge-* skills end-to-end.',
  },
  {
    icon: Zap,
    title: 'Real-time pipeline',
    body:
      'WebSocket events broadcast issue + agent + job state across all UIs. Self-healing classifier + sweeper recovers stuck pipelines automatically.',
  },
  {
    icon: KeyRound,
    title: 'Open-source, Apache-2.0',
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
    <section id="features" className="border-b border-outline-variant/30">
      <div className="mx-auto max-w-5xl px-6 py-20">
        <div className="mb-10">
          <p className="mb-2 font-mono text-xs uppercase tracking-[0.15em] text-on-surface-variant">
            Why Forge
          </p>
          <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">
            Built for AI-assisted developers
          </h2>
          <p className="mt-3 max-w-2xl text-on-surface-variant">
            A control plane that respects your stack. Bring your own runners, your
            own models, your own infrastructure — Forge handles the orchestration.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="rounded-lg border border-outline-variant/40 bg-surface-container-low/40 p-5 backdrop-blur"
              >
                <div className="mb-3 inline-flex size-9 items-center justify-center rounded-md bg-surface-container-high text-on-surface">
                  <Icon className="size-4" />
                </div>
                <h3 className="mb-1.5 font-semibold text-on-surface">{feature.title}</h3>
                <p className="text-sm leading-relaxed text-on-surface-variant">
                  {feature.body}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
