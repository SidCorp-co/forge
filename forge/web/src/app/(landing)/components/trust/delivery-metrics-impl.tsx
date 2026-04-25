'use client';

import { useEffect, useRef } from 'react';
import { gsap, ScrollTrigger } from '@/lib/gsap-client';
import { deliveryMetrics } from '../../constants';

export function DeliveryMetrics() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    if (!containerRef.current) return;

    const ctx = gsap.context(() => {
      gsap.from('[data-metric-card]', {
        y: 40,
        opacity: 0,
        duration: 0.6,
        stagger: 0.15,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: containerRef.current,
          start: 'top 80%',
          once: true,
          scroller: '[data-theme]',
        },
      });

      const counters = containerRef.current!.querySelectorAll('[data-count]');
      counters.forEach((el) => {
        const target = parseInt(el.getAttribute('data-count') || '0', 10);
        const obj = { val: 0 };
        gsap.to(obj, {
          val: target,
          duration: 1.5,
          ease: 'power2.out',
          snap: { val: 1 },
          scrollTrigger: {
            trigger: containerRef.current,
            start: 'top 80%',
            once: true,
            scroller: '[data-theme]',
          },
          onUpdate: () => {
            el.textContent = Math.round(obj.val).toString();
          },
        });
      });

      gsap.from('[data-bar-fill]', {
        scaleX: 0,
        transformOrigin: 'left',
        duration: 1.2,
        stagger: 0.15,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: containerRef.current,
          start: 'top 80%',
          once: true,
          scroller: '[data-theme]',
        },
      });
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      className="grid grid-cols-2 lg:grid-cols-4 gap-6 py-12"
    >
      {deliveryMetrics.map((metric) => (
        <div
          key={metric.label}
          data-metric-card
          className="flex min-w-0 flex-col items-center rounded-xl bg-white px-4 py-6 shadow-sm"
        >
          <div className="flex items-baseline gap-1">
            <span
              data-count={metric.value}
              className="font-serif text-5xl tracking-tight text-on-surface"
            >
              0
            </span>
            {metric.suffix && (
              <span className="text-lg text-primary-fixed">{metric.suffix}</span>
            )}
          </div>
          <span className="mt-2 text-center text-sm text-primary-fixed">
            {metric.label}
          </span>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-outline-variant/30">
            <div
              data-bar-fill
              className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600"
              style={{ width: `${metric.bar}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
