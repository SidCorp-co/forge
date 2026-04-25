'use client';

import { useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { gsap, ScrollTrigger } from '@/lib/gsap-client';
import { ClientLogos } from './trust/client-logos';
import { TeamSnapshot } from './trust/team-snapshot';
import { VideoWalkthrough } from './trust/video-walkthrough';

const AmbientCanvas = dynamic(
  () => import('./ambient-canvas').then((m) => ({ default: m.AmbientCanvas })),
  { ssr: false }
);

export function LandingTrust() {
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    if (!sectionRef.current) return;

    const ctx = gsap.context(() => {
      gsap.from('[data-trust-header]', {
        y: 20,
        opacity: 0,
        duration: 0.8,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: sectionRef.current,
          start: 'top 80%',
          once: true,
          scroller: '[data-theme]',
        },
      });

      gsap.from('[data-trust-logos]', {
        x: -50,
        opacity: 0,
        duration: 0.8,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: '[data-trust-logos]',
          start: 'top 85%',
          once: true,
          scroller: '[data-theme]',
        },
      });
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  return (
    <section id="trust" ref={sectionRef} className="relative bg-surface-container-low py-24 overflow-hidden">
      <AmbientCanvas className="absolute inset-0 z-0" />
      <div className="max-w-5xl mx-auto px-6 relative">
      <div data-trust-header className="relative z-10 text-center mb-16">
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
      </div>

      <div data-trust-logos className="relative z-10">
        <ClientLogos />
      </div>

      <div className="relative z-10">
        <TeamSnapshot />
        <VideoWalkthrough />
      </div>
    </div></section>
  );
}
