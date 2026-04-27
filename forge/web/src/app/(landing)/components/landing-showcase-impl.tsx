'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, Play } from 'lucide-react';
import { showcaseDomains, showcaseProjects, type ShowcaseProject } from '../constants';

function ShowcaseCard({ project }: { project: ShowcaseProject }) {
  const link = project.demoUrl || project.videoUrl;
  const isVideo = !project.demoUrl && !!project.videoUrl;

  return (
    <motion.div
      layout
      whileHover={{ scale: 1.02 }}
      transition={{ duration: 0.3 }}
      className="group bg-white border border-outline-variant/20 rounded-2xl overflow-hidden shadow-sm hover:shadow-lg hover:shadow-black/8 transition-shadow"
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-gradient-to-br from-surface-container to-surface-container-high overflow-hidden">
        {project.thumbnail && (
          <img
            src={project.thumbnail}
            alt={project.title}
            className="absolute inset-0 w-full h-full object-cover object-top"
            loading="lazy"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />

        {/* Timeline badge */}
        <span className="absolute top-3 right-3 bg-white/90 backdrop-blur-sm text-xs font-mono px-2.5 py-1 rounded-full border border-outline-variant/30 shadow-sm">
          Built in {project.timelineDays} days
        </span>

        {/* Hover overlay */}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center gap-2 text-white text-sm font-medium"
          >
            {isVideo ? (
              <>
                <Play className="w-5 h-5" /> Watch walkthrough
              </>
            ) : (
              <>
                <ExternalLink className="w-4 h-4" /> View demo
              </>
            )}
          </a>
        )}
      </div>

      {/* Content */}
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-base">{project.title}</h3>
          <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-warning/10 text-warning">
            {project.domain}
          </span>
        </div>

        {/* Problem → Solution → Result */}
        <div className="space-y-2.5 text-sm leading-relaxed">
          <div>
            <span className="font-mono text-[10px] uppercase tracking-widest text-warning/70 block mb-0.5">Problem</span>
            <p className="text-primary-fixed font-light">{project.problem}</p>
          </div>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-widest text-warning/70 block mb-0.5">Solution</span>
            <p className="text-primary-fixed font-light">{project.solution}</p>
          </div>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-widest text-warning/70 block mb-0.5">Result</span>
            <p className="text-on-surface font-medium">{project.result}</p>
          </div>
        </div>

        {/* Tech stack tags */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {project.techStack.map((tech) => (
            <span
              key={tech}
              className="bg-surface-container-low text-xs px-2 py-0.5 rounded font-mono text-primary-fixed"
            >
              {tech}
            </span>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

export function LandingShowcase() {
  const [activeDomain, setActiveDomain] = useState<string>('All');

  const filtered = activeDomain === 'All'
    ? showcaseProjects
    : showcaseProjects.filter((p) => p.domain === activeDomain);

  return (
    <section id="showcase" className="scroll-mt-20 max-w-5xl mx-auto px-6 py-24">
      <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
        Case Studies
      </p>
      <h2 className="font-serif text-3xl sm:text-4xl tracking-tight mb-3">
        Proof of concept,<br />proven in production.
      </h2>
      <p className="text-primary-fixed max-w-lg text-base font-light leading-relaxed mb-10">
        Real projects, real timelines. Every POC built with the same stack and team you&apos;d work with.
      </p>

      {/* Domain filter */}
      <div className="flex flex-wrap gap-2 mb-10">
        {showcaseDomains.map((domain) => (
          <button
            key={domain}
            onClick={() => setActiveDomain(domain)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-[transform,opacity,background-color,color] duration-200 ${
              activeDomain === domain
                ? 'bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white text-white shadow-sm'
                : 'bg-white text-primary-fixed hover:bg-surface-container-low border border-outline-variant/30'
            }`}
          >
            {domain}
          </button>
        ))}
      </div>

      {/* Card grid */}
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: '-15%' }}
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.12 } },
        }}
        className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6"
      >
        <AnimatePresence mode="popLayout">
          {filtered.length > 0 ? (
            filtered.map((project) => (
              <motion.div
                key={project.title}
                variants={{
                  hidden: { y: 60, opacity: 0 },
                  visible: { y: 0, opacity: 1, transition: { duration: 0.6, ease: 'easeOut' } },
                }}
              >
                <ShowcaseCard project={project} />
              </motion.div>
            ))
          ) : (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="col-span-full text-center text-primary-fixed text-sm py-12"
            >
              No projects in this domain yet.
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>
    </section>
  );
}
