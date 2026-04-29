'use client';

import { motion } from 'framer-motion';
import { ArrowRight, Github } from 'lucide-react';

const REPO_URL = 'https://github.com/SidCorp-co/forge';

const ease = 'easeOut' as const;

export function LandingCta() {
  return (
    <section
      id="cta"
      className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-24 text-center"
    >
      <div className="pointer-events-none absolute bottom-[20%] left-1/2 -translate-x-1/2 w-[500px] h-[350px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.06)_0%,transparent_70%)]" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.6, ease }}
      >
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Self-host it
        </p>
        <h2 className="font-serif text-4xl sm:text-5xl tracking-tight mb-4">
          Devices yours.{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            Compute yours.
          </span>
        </h2>
        <p className="text-primary-fixed max-w-md mx-auto text-base font-light leading-relaxed mb-10">
          Apache-2.0, self-hostable, MCP-native. The orchestration is
          open-source — the AI runs on your hardware, paid for by your Claude
          subscription.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <a
            href="#quickstart"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white px-7 py-4 font-medium text-white text-base transition-[transform,box-shadow] hover:-translate-y-0.5 shadow-[0_4px_24px_rgba(133,83,0,0.25)] hover:shadow-[0_8px_40px_rgba(133,83,0,0.35)]"
          >
            Run quickstart
            <ArrowRight className="w-5 h-5" />
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-on-surface/80 bg-white px-7 py-4 font-medium text-on-surface text-base transition-[transform,box-shadow,background-color] hover:-translate-y-0.5 hover:bg-on-surface hover:text-white shadow-sm"
          >
            <Github className="w-5 h-5" />
            Star on GitHub
          </a>
        </div>

        <p className="mt-8 text-xs text-primary-fixed font-light">
          No telemetry. No phone-home. No proprietary plugins required.
        </p>
      </motion.div>
    </section>
  );
}
