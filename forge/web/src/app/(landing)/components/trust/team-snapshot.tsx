'use client';

import { useEffect, useRef } from 'react';
import { gsap } from '@/lib/gsap-client';
import { teamMembers, teamCapability, teamCount } from '../../constants';

export function TeamSnapshot() {
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!gridRef.current) return;

    const ctx = gsap.context(() => {
      const cards = gridRef.current!.querySelectorAll('[data-team-card]');
      gsap.from(cards, {
        y: 30,
        opacity: 0,
        stagger: 0.1,
        duration: 0.6,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: gridRef.current,
          start: 'top 80%',
          once: true,
          scroller: '[data-theme]',
        },
      });
    }, gridRef);

    return () => ctx.revert();
  }, []);

  return (
    <div className="py-12">
      <div
        ref={gridRef}
        className="mx-auto grid max-w-2xl grid-cols-2 gap-6 md:grid-cols-3"
      >
        {teamMembers.map((member) => (
          <div
            key={member.name}
            data-team-card
            className="flex flex-col items-center gap-2"
          >
            <div
              className={`h-20 w-20 rounded-full bg-gradient-to-br ${member.gradient} flex items-center justify-center text-2xl font-bold text-white shadow-lg`}
            >
              {member.name.charAt(0)}
            </div>
            <span className="text-sm font-medium text-on-surface">{member.name}</span>
            <span className="text-xs text-primary-fixed">{member.role}</span>
          </div>
        ))}
      </div>

      <div className="mt-8 text-center">
        <p className="text-lg font-medium text-on-surface">{teamCount}</p>
        <p className="mt-1 text-sm text-primary-fixed">{teamCapability}</p>
      </div>
    </div>
  );
}
