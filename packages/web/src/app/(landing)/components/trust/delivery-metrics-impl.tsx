'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { deliveryMetrics } from '../../constants';

function CountUp({ to, suffix }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-20%' });
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const duration = 1500;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      // ease-out quadratic
      const eased = 1 - (1 - t) * (1 - t);
      setValue(Math.round(to * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, to]);

  return (
    <div className="flex items-baseline gap-1">
      <span
        ref={ref}
        className="font-serif text-5xl tracking-tight text-on-surface"
      >
        {value}
      </span>
      {suffix && <span className="text-lg text-primary-fixed">{suffix}</span>}
    </div>
  );
}

export function DeliveryMetrics() {
  return (
    <motion.div
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-20%' }}
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.15 } },
      }}
      className="grid grid-cols-2 lg:grid-cols-4 gap-6 py-12"
    >
      {deliveryMetrics.map((metric) => (
        <motion.div
          key={metric.label}
          variants={{
            hidden: { y: 40, opacity: 0 },
            visible: { y: 0, opacity: 1, transition: { duration: 0.6, ease: 'easeOut' } },
          }}
          className="flex min-w-0 flex-col items-center rounded-xl bg-white px-4 py-6 shadow-sm"
        >
          <CountUp to={metric.value} suffix={metric.suffix} />
          <span className="mt-2 text-center text-sm text-primary-fixed">
            {metric.label}
          </span>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-outline-variant/30">
            <motion.div
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true, margin: '-20%' }}
              transition={{ duration: 1.2, ease: 'easeOut' }}
              style={{ width: `${metric.bar}%`, transformOrigin: 'left' }}
              className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600"
            />
          </div>
        </motion.div>
      ))}
    </motion.div>
  );
}
