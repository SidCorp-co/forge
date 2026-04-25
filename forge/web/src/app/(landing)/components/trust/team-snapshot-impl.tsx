'use client';

import { motion } from 'framer-motion';
import { teamMembers, teamCapability, teamCount } from '../../constants';

export function TeamSnapshot() {
  return (
    <div className="py-12">
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: '-20%' }}
        variants={{
          hidden: {},
          visible: {
            transition: { staggerChildren: 0.1 },
          },
        }}
        className="mx-auto grid max-w-2xl grid-cols-2 gap-6 md:grid-cols-3"
      >
        {teamMembers.map((member) => (
          <motion.div
            key={member.name}
            variants={{
              hidden: { y: 30, opacity: 0 },
              visible: { y: 0, opacity: 1, transition: { duration: 0.6, ease: 'easeOut' } },
            }}
            className="flex flex-col items-center gap-2"
          >
            <div
              className={`h-20 w-20 rounded-full bg-gradient-to-br ${member.gradient} flex items-center justify-center text-2xl font-bold text-white shadow-lg`}
            >
              {member.name.charAt(0)}
            </div>
            <span className="text-sm font-medium text-on-surface">{member.name}</span>
            <span className="text-xs text-primary-fixed">{member.role}</span>
          </motion.div>
        ))}
      </motion.div>

      <div className="mt-8 text-center">
        <p className="text-lg font-medium text-on-surface">{teamCount}</p>
        <p className="mt-1 text-sm text-primary-fixed">{teamCapability}</p>
      </div>
    </div>
  );
}
