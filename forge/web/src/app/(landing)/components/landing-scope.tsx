'use client';

import { Check, X, Clock } from 'lucide-react';
import { motion } from 'framer-motion';

const included = [
  'Discovery & research',
  'UI/UX design',
  'Full-stack build',
  'Handoff & documentation',
  'Launch support',
];

const notIncluded = [
  'Production scaling',
  'Ongoing maintenance',
  { label: 'SLA support', note: 'unless upgraded' },
  '24/7 on-call',
];

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.1 },
  },
};

const ease = 'easeOut' as const;

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease } },
};

export function LandingScope() {
  return (
    <section className="relative max-w-5xl mx-auto px-6 py-24">
      <div className="pointer-events-none absolute top-[10%] left-1/2 -translate-x-1/2 w-[600px] h-[400px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.04)_0%,transparent_70%)]" />

      <motion.div
        className="text-center mb-16"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Scope
        </p>
        <h2 className="font-serif text-4xl sm:text-5xl tracking-tight mb-4">
          Honest{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            boundaries
          </span>
        </h2>
        <p className="text-primary-fixed max-w-md mx-auto text-base font-light leading-relaxed">
          Clear expectations from day one. Know exactly what you get — and what you don&apos;t.
        </p>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
        {/* Included */}
        <motion.div
          className="rounded-2xl border border-outline-variant/20 bg-white p-6 shadow-sm"
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
        >
          <h3 className="font-mono text-xs tracking-[0.15em] uppercase text-success mb-5">
            What&apos;s Included
          </h3>
          <ul className="space-y-3">
            {included.map((item) => (
              <motion.li
                key={item}
                className="flex items-center gap-3 text-on-surface"
                variants={itemVariants}
              >
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-success/10 flex items-center justify-center">
                  <Check className="w-3.5 h-3.5 text-success" />
                </span>
                <span className="text-sm font-light">{item}</span>
              </motion.li>
            ))}
          </ul>
        </motion.div>

        {/* Not Included */}
        <motion.div
          className="rounded-2xl border border-outline-variant/20 bg-white p-6 shadow-sm"
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
        >
          <h3 className="font-mono text-xs tracking-[0.15em] uppercase text-error mb-5">
            Not Included
          </h3>
          <ul className="space-y-3">
            {notIncluded.map((item) => {
              const label = typeof item === 'string' ? item : item.label;
              const note = typeof item === 'string' ? null : item.note;
              return (
                <motion.li
                  key={label}
                  className="flex items-center gap-3 text-on-surface"
                  variants={itemVariants}
                >
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-error/10 flex items-center justify-center">
                    <X className="w-3.5 h-3.5 text-error" />
                  </span>
                  <span className="text-sm font-light">
                    {label}
                    {note && (
                      <span className="text-primary-fixed ml-1.5 text-xs italic">
                        ({note})
                      </span>
                    )}
                  </span>
                </motion.li>
              );
            })}
          </ul>
        </motion.div>
      </div>

      {/* Timeline badge */}
      <motion.div
        className="flex justify-center"
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      >
        <div className="inline-flex items-center gap-2 rounded-full border border-outline-variant/30 bg-white px-5 py-2.5 shadow-sm">
          <Clock className="w-4 h-4 text-warning" />
          <span className="font-mono text-sm text-on-surface">
            2–4 weeks from kickoff
          </span>
        </div>
      </motion.div>
    </section>
  );
}
