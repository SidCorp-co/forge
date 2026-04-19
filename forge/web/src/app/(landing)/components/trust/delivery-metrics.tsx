'use client';

import { useEffect, useRef } from 'react';
import { deliveryMetrics } from '../../constants';

export function DeliveryMetrics() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let ctx: ReturnType<typeof import('gsap')['default']['context']> | undefined;

    const init = async () => {
      const gsap = (await import('gsap')).default;
      if (cancelled) return;
      const { ScrollTrigger } = await import('gsap/ScrollTrigger');
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);

      ctx = gsap.context(() => {
        // Card fly-in animation
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

        // Counter animation
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

        // Loading bar animation
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
    };

    init();

    return () => {
      cancelled = true;
      ctx?.revert();
    };
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
