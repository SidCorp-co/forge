'use client';

import { motion } from 'framer-motion';
import { clientLogos } from '../../constants';

export function ClientLogos() {
  const logos = [...clientLogos, ...clientLogos];

  return (
    <div className="relative overflow-hidden py-8">
      {/* Fade edges */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-background to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-background to-transparent" />

      <div className="flex w-max animate-marquee gap-16">
        {logos.map((logo, i) => (
          <motion.div
            key={`${logo.name}-${i}`}
            className="flex flex-shrink-0 items-center gap-3 grayscale opacity-50 transition-opacity hover:opacity-100"
            whileHover={{ filter: 'grayscale(0%)' }}
            initial={{ filter: 'grayscale(100%)' }}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-8 w-8"
              fill="none"
              stroke={logo.color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={logo.path} />
            </svg>
            <span className="whitespace-nowrap text-sm font-medium text-primary-fixed">
              {logo.name}
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
