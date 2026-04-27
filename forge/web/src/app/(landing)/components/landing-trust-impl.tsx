'use client';

import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import { ClientLogos } from './trust/client-logos';
import { TeamSnapshot } from './trust/team-snapshot-impl';
import { VideoWalkthrough } from './trust/video-walkthrough';

const AmbientCanvas = dynamic(
  () => import('./ambient-canvas').then((m) => ({ default: m.AmbientCanvas })),
  { ssr: false }
);

export function LandingTrust() {
  return (
    <section id="trust" className="scroll-mt-20 relative bg-surface-container-low py-24 overflow-hidden">
      <AmbientCanvas className="absolute inset-0 z-0" />
      <div className="max-w-5xl mx-auto px-6 relative">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-20%' }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className="relative z-10 text-center mb-16"
        >
          <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
            Trust
          </p>
          <h2 className="font-serif text-4xl sm:text-5xl tracking-tight mb-4">
            Built by people who{' '}
            <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
              ship
            </span>
          </h2>
          <p className="text-primary-fixed max-w-md mx-auto text-base font-light leading-relaxed">
            Proven delivery across domains. Real teams, real results, real fast.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: -50 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: '-15%' }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className="relative z-10"
        >
          <ClientLogos />
        </motion.div>

        <div className="relative z-10">
          <TeamSnapshot />
          <VideoWalkthrough />
        </div>
      </div>
    </section>
  );
}
