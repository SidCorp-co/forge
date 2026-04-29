'use client';

import { motion } from 'framer-motion';
import { audienceTiles } from '../constants';

const ease = 'easeOut' as const;

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease } },
};

export function LandingWhy() {
  return (
    <section
      id="why"
      className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-28"
    >
      <div className="pointer-events-none absolute -top-12 right-[-10%] w-[420px] h-[420px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.05)_0%,transparent_70%)]" />

      <motion.div
        className="text-center mb-14"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.6, ease }}
      >
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Who it&apos;s for
        </p>
        <h2 className="font-serif text-4xl sm:text-5xl tracking-tight mb-4">
          Built for teams that{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            ship software
          </span>
        </h2>
        <p className="text-primary-fixed max-w-xl mx-auto text-base font-light leading-relaxed">
          Forge fits operators delivering paid client work, internal teams
          managing multiple projects, and any team that needs Claude credentials
          and code to stay on their own infrastructure.
        </p>
      </motion.div>

      <motion.div
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.3 }}
        className="grid grid-cols-1 md:grid-cols-3 gap-5"
      >
        {audienceTiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <motion.div
              key={tile.label}
              variants={itemVariants}
              className="rounded-2xl border border-outline-variant/20 bg-white p-6 shadow-sm"
            >
              <div className="inline-flex w-10 h-10 items-center justify-center rounded-lg bg-warning/10 text-warning mb-4">
                <Icon className="w-5 h-5" />
              </div>
              <p className="text-sm font-medium text-on-surface mb-2 leading-snug">
                {tile.label}
              </p>
              <p className="text-xs text-primary-fixed leading-relaxed">
                {tile.body}
              </p>
            </motion.div>
          );
        })}
      </motion.div>
    </section>
  );
}
