'use client';

import { useState } from 'react';
import { Calendar, ChevronDown, ChevronUp } from 'lucide-react';
import { motion } from 'framer-motion';

const BOOKING_URL = 'https://cal.com/sidcorp/scoping-call';

const budgetOptions = ['< $5k', '$5k–$15k', '$15k–$50k', '$50k+'];
const timelineOptions = ['ASAP', '1–2 months', '3+ months'];

export function LandingCta() {
  const [showForm, setShowForm] = useState(false);

  return (
    <section id="book" className="relative max-w-5xl mx-auto px-6 py-24 text-center">
      <div className="pointer-events-none absolute bottom-[20%] left-1/2 -translate-x-1/2 w-[500px] h-[350px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.06)_0%,transparent_70%)]" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Let&apos;s Talk
        </p>
        <h2 className="font-serif text-4xl sm:text-5xl tracking-tight mb-4">
          Ready to{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            validate
          </span>{' '}
          your idea?
        </h2>
        <p className="text-primary-fixed max-w-md mx-auto text-base font-light leading-relaxed mb-10">
          Book a free 30-minute scoping call. We&apos;ll map your idea to a deliverable POC — no strings attached.
        </p>

        {/* Primary CTA with pulse animation */}
        <motion.a
          href={BOOKING_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] px-8 py-4 text-lg font-medium text-white transition-all hover:-translate-y-0.5"
          animate={{
            scale: [1, 1.02, 1],
            boxShadow: [
              '0 0 0 1px rgba(249,115,22,0.3), 0 4px 24px rgba(249,115,22,0.2)',
              '0 0 0 2px rgba(249,115,22,0.4), 0 8px 40px rgba(249,115,22,0.35)',
              '0 0 0 1px rgba(249,115,22,0.3), 0 4px 24px rgba(249,115,22,0.2)',
            ],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        >
          <Calendar className="w-5 h-5" />
          Book a Scoping Call
        </motion.a>

        {/* Toggle for optional intake form */}
        <button
          onClick={() => setShowForm(!showForm)}
          className="mt-6 inline-flex items-center gap-1.5 text-sm text-primary-fixed hover:text-on-surface transition-colors"
        >
          {showForm ? 'Hide' : 'Or fill out a quick intake form'}
          {showForm ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>
      </motion.div>

      {/* Optional intake form */}
      <motion.div
        initial={false}
        animate={{
          height: showForm ? 'auto' : 0,
          opacity: showForm ? 1 : 0,
        }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
        className="overflow-hidden"
      >
        <form
          className="max-w-md mx-auto mt-8 space-y-4 text-left"
          onSubmit={(e) => e.preventDefault()}
        >
          <div>
            <label className="block font-mono text-xs tracking-[0.1em] uppercase text-primary-fixed mb-1.5">
              Project Idea
            </label>
            <textarea
              rows={3}
              placeholder="Describe your idea in a few sentences..."
              className="w-full rounded-xl border border-outline-variant/30 bg-white px-4 py-3 text-sm text-on-surface placeholder:text-primary-fixed/50 focus:border-warning focus:outline-none focus:ring-1 focus:ring-warning/30 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block font-mono text-xs tracking-[0.1em] uppercase text-primary-fixed mb-1.5">
                Budget Range
              </label>
              <select className="w-full rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface focus:border-warning focus:outline-none focus:ring-1 focus:ring-warning/30 appearance-none">
                <option value="">Select...</option>
                {budgetOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-mono text-xs tracking-[0.1em] uppercase text-primary-fixed mb-1.5">
                Timeline
              </label>
              <select className="w-full rounded-xl border border-outline-variant bg-surface-container-low px-4 py-3 text-sm text-on-surface focus:border-warning focus:outline-none focus:ring-1 focus:ring-warning/30 appearance-none">
                <option value="">Select...</option>
                {timelineOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="submit"
            className="w-full rounded-xl bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] px-6 py-3 font-medium text-white hover:opacity-90 transition-all shadow-sm"
          >
            Send Inquiry
          </button>
        </form>
      </motion.div>
    </section>
  );
}
