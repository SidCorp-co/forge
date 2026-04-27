'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import { Calendar, Zap, Cpu, Layers } from 'lucide-react';

const SPLINE_SCENE_URL =
  process.env.NEXT_PUBLIC_SPLINE_SCENE_URL ||
  'https://prod.spline.design/6Wq1Q7YGyM-iab9i/scene.splinecode';

const SplineScene = dynamic(() => import('@splinetool/react-spline'), {
  ssr: false,
  loading: () => null,
});

function checkWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(
      canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    );
  } catch {
    return false;
  }
}

const ease = 'easeOut' as const;

const differentiators = [
  { icon: Zap, label: 'Rapid Delivery' },
  { icon: Cpu, label: 'AI-Augmented Pipeline' },
  { icon: Layers, label: 'Full-Stack Capability' },
];

export function LandingHero() {
  const [supportsWebGL, setSupportsWebGL] = useState(false);
  const [splineLoaded, setSplineLoaded] = useState(false);

  useEffect(() => {
    setSupportsWebGL(checkWebGL());
  }, []);

  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center px-6 pt-24 pb-16 text-center overflow-hidden">
      {/* Spline 3D Background or Gradient Fallback */}
      {supportsWebGL ? (
        <div className="pointer-events-none absolute inset-0 z-0">
          <SplineScene
            scene={SPLINE_SCENE_URL}
            onLoad={() => setSplineLoaded(true)}
            style={{ width: '100%', height: '100%' }}
          />
          {/* Overlay for text readability */}
          <div className="absolute inset-0 bg-gradient-to-b from-white/70 via-white/50 to-white/90" />
        </div>
      ) : null}

      {/* Gradient fallback — always rendered, fades out when Spline loads */}
      <div
        className={`pointer-events-none absolute inset-0 z-0 transition-opacity duration-1000 ${
          supportsWebGL && splineLoaded ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.08)_0%,rgba(249,115,22,0.03)_30%,rgba(124,58,237,0.03)_60%,transparent_80%)] animate-pulse" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[600px] h-[600px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.05)_0%,transparent_70%)] animate-pulse [animation-delay:1s]" />
      </div>

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center">
        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease }}
          className="inline-flex items-center gap-2 rounded-full border border-outline-variant/40 bg-white/80 backdrop-blur-sm px-4 py-1.5 text-xs text-primary-fixed font-mono tracking-wide mb-8 shadow-sm"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
          POC Studio &middot; SidCorp
        </motion.div>

        {/* Headline */}
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15, ease }}
          className="font-serif text-5xl sm:text-6xl md:text-7xl lg:text-8xl tracking-tight leading-[1.05] mb-6"
        >
          <span className="text-on-surface">From Idea to</span>
          <br />
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            Working POC
          </span>
          <br />
          <span className="text-on-surface text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-light">
            in Days, Not Months
          </span>
        </motion.h1>

        {/* Subheadline */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.25, ease }}
          className="text-lg sm:text-xl text-primary-fixed max-w-xl mx-auto font-light leading-relaxed mb-10"
        >
          We turn your vision into a fully functional proof of concept —
          designed, built, and delivered with AI-augmented speed.
        </motion.p>

        {/* Differentiators */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.35, ease }}
          className="flex flex-wrap justify-center gap-3 mb-12"
        >
          {differentiators.map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="inline-flex items-center gap-2 rounded-full border border-outline-variant/40 bg-white/60 backdrop-blur-sm px-4 py-2 text-sm text-on-surface shadow-sm"
            >
              <Icon className="w-4 h-4 text-warning" />
              <span className="font-light">{label}</span>
            </div>
          ))}
        </motion.div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.45, ease }}
          className="flex flex-col items-center gap-5"
        >
          <a
            href={process.env.NEXT_PUBLIC_BOOKING_URL || '#book'}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] px-8 py-4 font-medium text-white text-lg transition-all hover:-translate-y-0.5 shadow-[0_4px_24px_rgba(133,83,0,0.25)] hover:shadow-[0_8px_40px_rgba(133,83,0,0.35)]"
          >
            <Calendar className="w-5 h-5" />
            Book a 30-min Scoping Call
          </a>

          {/* Quiet secondary path: surface the open-source engine without
              competing with the primary scoping-call ask. */}
          <div className="flex items-center gap-2.5 text-xs text-primary-fixed font-light">
            <span className="h-px w-6 bg-outline-variant/40" />
            <span>or</span>
            <a
              href="#forge"
              className="inline-flex items-center gap-1.5 text-on-surface hover:text-warning transition-colors group"
            >
              <span>use the engine we built</span>
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </a>
            <span className="h-px w-6 bg-outline-variant/40" />
          </div>
        </motion.div>
      </div>
    </section>
  );
}
