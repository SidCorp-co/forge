'use client';

import { motion } from 'framer-motion';
import { Check, Clock } from 'lucide-react';
import { lifecycleStages } from '../constants';

const ease = 'easeOut' as const;

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease } },
};

/**
 * Lifecycle Scope — visualizes the 7-stage lifecycle with a clear split
 * between "ships today" (Build / Review / Launch / Maintain) and "roadmap"
 * (Idea / Spec / Design). Honest about current capability without burying
 * the long-term vision.
 */
export function LandingScope() {
  return (
    <section
      id="scope"
      className="scroll-mt-20 relative max-w-5xl mx-auto px-6 py-28"
    >
      <div className="pointer-events-none absolute -top-12 right-[-10%] w-[500px] h-[400px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.05)_0%,transparent_70%)]" />

      <motion.div
        className="text-center mb-16"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.6, ease }}
      >
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Lifecycle scope
        </p>
        <h2 className="font-serif text-4xl sm:text-5xl tracking-tight mb-4">
          Today, and{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            where we&apos;re going
          </span>
        </h2>
        <p className="text-primary-fixed max-w-xl mx-auto text-base font-light leading-relaxed">
          The full vision: every stage from idea to maintenance. Today, Forge
          ships the build-through-maintain half. Idea, Spec, and Design are
          next.
        </p>
      </motion.div>

      <motion.ol
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.2 }}
        className="relative grid grid-cols-1 sm:grid-cols-7 gap-3"
      >
        {lifecycleStages.map((stage) => {
          const isToday = stage.status === 'today';
          return (
            <motion.li
              key={stage.name}
              variants={itemVariants}
              className={`relative rounded-2xl border p-5 transition-colors ${
                isToday
                  ? 'border-warning/40 bg-white shadow-sm'
                  : 'border-outline-variant/20 bg-surface-container-low/40 opacity-70'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                {isToday ? (
                  <span className="inline-flex w-5 h-5 items-center justify-center rounded-full bg-success/15 text-success">
                    <Check className="w-3 h-3" />
                  </span>
                ) : (
                  <span className="inline-flex w-5 h-5 items-center justify-center rounded-full bg-outline-variant/30 text-primary-fixed">
                    <Clock className="w-3 h-3" />
                  </span>
                )}
                <p className="font-serif text-lg text-on-surface">
                  {stage.name}
                </p>
              </div>
              <p
                className={`font-mono text-[10px] uppercase tracking-[0.18em] mb-2 ${
                  isToday ? 'text-success' : 'text-primary-fixed/60'
                }`}
              >
                {isToday ? 'Today' : 'Roadmap'}
              </p>
              <p className="text-xs text-primary-fixed leading-relaxed">
                {stage.description}
              </p>
            </motion.li>
          );
        })}
      </motion.ol>
    </section>
  );
}
