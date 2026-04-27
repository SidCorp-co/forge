'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowUpRight, Cpu, Download, Github, Network, Shield } from 'lucide-react';

const ease = 'easeOut' as const;

// Real-feel pipeline log — these are stages a single issue actually walks
// through in Forge. Each step animates in on scroll to give the section a
// pulse without falling into "fake terminal" cliché.
const pipelineSteps = [
  { stage: 'triage', from: 'open', to: 'confirmed', delay: 0.0 },
  { stage: 'plan', from: 'confirmed', to: 'approved', delay: 0.12 },
  { stage: 'code', from: 'approved', to: 'developed', delay: 0.24 },
  { stage: 'review', from: 'developed', to: 'pass', delay: 0.36, glyph: '✓' },
  { stage: 'release', from: 'pass', to: 'main', delay: 0.48 },
];

const pillars = [
  {
    icon: Cpu,
    label: 'Local-first runner',
    body: 'Your Claude CLI on your machine. No proxy, no token shipped to a third party.',
  },
  {
    icon: Network,
    label: 'MCP-native',
    body: 'Per-project MCP servers. The desktop and the cloud speak the same protocol end-to-end.',
  },
  {
    icon: Shield,
    label: 'Apache-2.0',
    body: 'Use it commercially, fork it, embed it. No telemetry, no phone-home.',
  },
];

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease } },
};

export function LandingForge() {
  return (
    <section
      id="forge"
      className="relative max-w-5xl mx-auto px-6 py-28 overflow-hidden"
    >
      {/* Ambient glows — match the page-wide amber/violet vocabulary */}
      <div className="pointer-events-none absolute -top-20 left-1/2 -translate-x-1/2 w-[700px] h-[400px] rounded-full bg-[radial-gradient(ellipse,rgba(249,115,22,0.06)_0%,transparent_70%)]" />
      <div className="pointer-events-none absolute bottom-0 right-[-15%] w-[420px] h-[420px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.05)_0%,transparent_70%)]" />

      {/* Header */}
      <motion.div
        className="text-center mb-14"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.6, ease }}
      >
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          The Engine
        </p>
        <h2 className="font-serif text-4xl sm:text-5xl md:text-6xl tracking-tight leading-[1.05] mb-5">
          <span className="text-on-surface">Built in public,</span>
          <br />
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            yours to ship
          </span>
        </h2>
        <p className="text-primary-fixed max-w-xl mx-auto text-base sm:text-lg font-light leading-relaxed">
          The same engine we use to ship POCs is now open-source. The AI-augmented
          pipeline, the runners, the orchestration — Apache-2.0, no strings.
        </p>
      </motion.div>

      {/* Pipeline log mockup — distinctive visual, not a fake console */}
      <motion.div
        className="relative mb-14"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.6, ease, delay: 0.1 }}
      >
        <div className="rounded-2xl border border-outline-variant/20 bg-white p-6 sm:p-8 shadow-sm">
          {/* "Live" header */}
          <div className="flex items-center justify-between mb-5 pb-4 border-b border-outline-variant/15">
            <div className="flex items-center gap-2">
              <span className="relative flex w-2 h-2">
                <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-60" />
                <span className="relative w-2 h-2 rounded-full bg-success" />
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-on-surface">
                Pipeline · ISS-294
              </span>
            </div>
            <span className="font-mono text-[11px] text-primary-fixed/70">
              chat sessions + chat_logs + system prompt
            </span>
          </div>

          {/* Steps */}
          <motion.ol
            variants={containerVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.4 }}
            className="space-y-2.5"
          >
            {pipelineSteps.map((step) => (
              <motion.li
                key={step.stage}
                variants={itemVariants}
                className="grid grid-cols-[5rem_1fr_auto] items-center gap-3 sm:gap-5 font-mono text-xs sm:text-sm"
              >
                <span className="text-primary-fixed/70 uppercase tracking-wider">
                  {step.stage}
                </span>
                <span className="flex items-center gap-2 text-on-surface">
                  <span className="text-primary-fixed/60">{step.from}</span>
                  <span className="text-primary-fixed/40">→</span>
                  <span
                    className={
                      step.to === 'main'
                        ? 'text-success font-medium'
                        : step.to === 'pass'
                          ? 'text-success'
                          : 'text-on-surface'
                    }
                  >
                    {step.to}
                  </span>
                </span>
                <span className="text-success font-medium">
                  {step.glyph ?? '·'}
                </span>
              </motion.li>
            ))}
          </motion.ol>

          {/* Footer line */}
          <div className="mt-5 pt-4 border-t border-outline-variant/15 flex items-center justify-between text-[11px] font-mono text-primary-fixed/70">
            <span>5 stages · 47 minutes · 1 reviewer</span>
            <span className="text-success">✓ released</span>
          </div>
        </div>
      </motion.div>

      {/* Pillars */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.3 }}
        className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-14"
      >
        {pillars.map((pillar) => {
          const Icon = pillar.icon;
          return (
            <motion.div
              key={pillar.label}
              variants={itemVariants}
              className="rounded-2xl border border-outline-variant/20 bg-white/60 backdrop-blur-sm p-5 shadow-sm"
            >
              <div className="inline-flex w-9 h-9 items-center justify-center rounded-lg bg-warning/10 text-warning mb-3">
                <Icon className="w-4 h-4" />
              </div>
              <p className="text-sm font-medium text-on-surface mb-1">
                {pillar.label}
              </p>
              <p className="text-xs text-primary-fixed leading-relaxed">
                {pillar.body}
              </p>
            </motion.div>
          );
        })}
      </motion.div>

      {/* CTA row */}
      <motion.div
        className="flex flex-col sm:flex-row items-center justify-center gap-4"
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.5, ease }}
      >
        <Link
          href="/download"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] px-7 py-3.5 font-medium text-white text-base transition-all hover:-translate-y-0.5 shadow-[0_4px_24px_rgba(133,83,0,0.22)] hover:shadow-[0_8px_40px_rgba(133,83,0,0.32)]"
        >
          <Download className="w-4 h-4" />
          Download Forge Beta
        </Link>
        <a
          href="https://github.com/junixlabs/jarvis-agents"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary-fixed hover:text-on-surface transition-colors"
        >
          <Github className="w-4 h-4" />
          View source on GitHub
          <ArrowUpRight className="w-3.5 h-3.5" />
        </a>
      </motion.div>
    </section>
  );
}
