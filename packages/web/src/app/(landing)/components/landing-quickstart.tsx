'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Terminal, ExternalLink, Github } from 'lucide-react';

const ease = 'easeOut' as const;

const REPO_URL = 'https://github.com/SidCorp-co/forge';

const commands = [
  { line: '$ git clone https://github.com/SidCorp-co/forge.git', tone: 'cmd' as const },
  { line: '$ cd forge', tone: 'cmd' as const },
  { line: '$ cp .env.example .env', tone: 'cmd' as const },
  { line: '$ docker compose up -d', tone: 'cmd' as const },
  { line: '', tone: 'spacer' as const },
  { line: '✓ Core API ready at http://localhost:8080', tone: 'ok' as const },
  { line: '✓ Web dashboard ready at http://localhost:3000', tone: 'ok' as const },
];

export function LandingQuickstart() {
  return (
    <section
      id="quickstart"
      className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-28"
    >
      <div className="pointer-events-none absolute -top-12 left-1/2 -translate-x-1/2 w-[500px] h-[400px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.05)_0%,transparent_70%)]" />

      <motion.div
        className="text-center mb-12"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.6, ease }}
      >
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Quickstart
        </p>
        <h2 className="font-serif text-4xl sm:text-5xl tracking-tight mb-4">
          Up and running in{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            sixty seconds
          </span>
        </h2>
        <p className="text-primary-fixed max-w-xl mx-auto text-base font-light leading-relaxed">
          Self-host on your own infrastructure. Pair a device with the desktop
          agent (Tauri) afterward to spawn <code className="font-mono text-[13px] text-on-surface">claude</code>{' '}
          on your machine.
        </p>
      </motion.div>

      <motion.div
        className="rounded-2xl border border-outline-variant/20 bg-on-surface text-white p-6 sm:p-8 shadow-lg"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.6, ease, delay: 0.1 }}
      >
        <div className="flex items-center justify-between mb-5 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-warning" />
            <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-white/80">
              Terminal
            </span>
          </div>
          <span className="font-mono text-[11px] text-white/40">
            macOS · Linux · Windows (WSL)
          </span>
        </div>

        <pre className="font-mono text-xs sm:text-sm leading-relaxed overflow-x-auto">
          {commands.map((cmd, i) => {
            if (cmd.tone === 'spacer') {
              return <div key={i} className="h-2" aria-hidden />;
            }
            const className =
              cmd.tone === 'ok' ? 'text-success' : 'text-white/90';
            return (
              <div key={i} className={className}>
                {cmd.line}
              </div>
            );
          })}
        </pre>
      </motion.div>

      <motion.div
        className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4"
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.5, ease, delay: 0.2 }}
      >
        <Link
          href="/download"
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-on-surface/80 bg-white px-6 py-3 font-medium text-on-surface text-sm transition-[transform,box-shadow] hover:-translate-y-0.5 shadow-sm"
        >
          Get the desktop agent
          <ExternalLink className="w-4 h-4" />
        </Link>
        <a
          href={`${REPO_URL}#readme`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary-fixed hover:text-on-surface transition-colors"
        >
          <Github className="w-4 h-4" />
          Read the full quickstart on GitHub
        </a>
      </motion.div>
    </section>
  );
}
