'use client';

import { motion } from 'framer-motion';
import { ShieldCheck } from 'lucide-react';

const ease = 'easeOut' as const;

/**
 * Architecture diagram — visual reinforcement of VISION §1's load-bearing
 * claim: "the server never holds your Claude credentials."
 *
 * Two columns: control plane (server-side) and devices (operator-side).
 * The credential boundary line between them is the moat. Spelling it out
 * visually is more persuasive than burying it in copy.
 */
export function LandingArchitecture() {
  return (
    <section
      id="architecture"
      className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-28"
    >
      <div className="pointer-events-none absolute -top-12 left-[-10%] w-[500px] h-[400px] rounded-full bg-[radial-gradient(ellipse,rgba(34,197,94,0.05)_0%,transparent_70%)]" />

      <motion.div
        className="text-center mb-14"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.6, ease }}
      >
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Architecture
        </p>
        <h2 className="font-serif text-4xl sm:text-5xl tracking-tight mb-4">
          The server never holds{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            your credentials
          </span>
        </h2>
        <p className="text-primary-fixed max-w-xl mx-auto text-base font-light leading-relaxed">
          A control plane queues jobs and streams events. Devices you own run
          Claude Code locally. A breach of the server cannot leak your Claude
          tokens — they live in your OS keychain on your machines.
        </p>
      </motion.div>

      <motion.div
        className="rounded-2xl border border-outline-variant/20 bg-white p-6 sm:p-10 shadow-sm overflow-hidden"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.6, ease, delay: 0.1 }}
      >
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-6 items-stretch">
          {/* Control plane column */}
          <div className="space-y-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary-fixed/70 mb-3">
              Control plane (server)
            </p>
            <div className="rounded-xl border border-outline-variant/30 bg-surface-container-low/60 p-5">
              <p className="text-sm font-medium text-on-surface mb-1">
                Web app
              </p>
              <p className="text-xs text-primary-fixed font-mono">
                Next.js · React Query · WebSocket
              </p>
            </div>
            <div className="rounded-xl border-2 border-warning/40 bg-white p-5 shadow-sm">
              <p className="text-sm font-medium text-on-surface mb-1">
                Control plane
              </p>
              <p className="text-xs text-primary-fixed font-mono leading-relaxed">
                Hono · Drizzle · pg-boss · ws · MCP at /mcp
              </p>
              <p className="text-[11px] text-error mt-2 font-mono uppercase tracking-wider">
                ✗ no Claude credentials
              </p>
            </div>
            <div className="rounded-xl border border-outline-variant/30 bg-surface-container-low/60 p-5">
              <p className="text-sm font-medium text-on-surface mb-1">
                Postgres
              </p>
              <p className="text-xs text-primary-fixed font-mono">
                state + jobs + pgvector
              </p>
            </div>
          </div>

          {/* Credential boundary divider */}
          <div className="relative flex items-center justify-center lg:flex-col lg:gap-3 gap-3">
            <div className="hidden lg:block absolute inset-y-4 left-1/2 -translate-x-1/2 w-px bg-gradient-to-b from-warning/0 via-warning/50 to-warning/0" />
            <div className="lg:hidden absolute inset-x-4 top-1/2 -translate-y-1/2 h-px bg-gradient-to-r from-warning/0 via-warning/50 to-warning/0" />
            <div className="relative inline-flex items-center gap-2 rounded-full border border-warning/40 bg-white px-3 py-1.5 shadow-sm">
              <ShieldCheck className="w-3.5 h-3.5 text-warning" />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface">
                Credential boundary
              </span>
            </div>
          </div>

          {/* Device column */}
          <div className="space-y-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary-fixed/70 mb-3">
              Your devices (operator)
            </p>
            <div className="rounded-xl border border-outline-variant/30 bg-surface-container-low/60 p-5">
              <p className="text-sm font-medium text-on-surface mb-1">
                Device agent
              </p>
              <p className="text-xs text-primary-fixed font-mono">
                Tauri GUI or CLI daemon
              </p>
            </div>
            <div className="rounded-xl border-2 border-success/40 bg-white p-5 shadow-sm">
              <p className="text-sm font-medium text-on-surface mb-1">
                Claude CLI
              </p>
              <p className="text-xs text-primary-fixed font-mono leading-relaxed">
                spawned locally; tokens in OS keychain
              </p>
              <p className="text-[11px] text-success mt-2 font-mono uppercase tracking-wider">
                ✓ credentials stay here
              </p>
            </div>
            <div className="rounded-xl border border-outline-variant/30 bg-surface-container-low/60 p-5">
              <p className="text-sm font-medium text-on-surface mb-1">
                Local git worktree
              </p>
              <p className="text-xs text-primary-fixed font-mono">
                code never leaves your machine
              </p>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-outline-variant/15 flex items-center justify-between text-[11px] font-mono text-primary-fixed/70">
          <span>Dual-principal auth: user JWT + device token</span>
          <span>Apache-2.0 · self-hostable</span>
        </div>
      </motion.div>
    </section>
  );
}
