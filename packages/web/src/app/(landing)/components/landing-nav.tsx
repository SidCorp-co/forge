import Link from 'next/link';
import { Github } from 'lucide-react';

const REPO_URL = 'https://github.com/SidCorp-co/forge';

export function LandingNav() {
  return (
    <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 py-4 backdrop-blur-2xl bg-white/70 border-b border-outline-variant/30">
      <Link
        href="/"
        className="inline-flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.32em] text-on-surface hover:text-warning transition-colors"
      >
        <span aria-hidden className="block h-2 w-2 bg-warning" />
        Forge
      </Link>
      <div className="flex items-center gap-6">
        <a
          href="#why"
          className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm"
        >
          Why Forge
        </a>
        <a
          href="#pipeline"
          className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm"
        >
          Pipeline
        </a>
        <a
          href="#architecture"
          className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm"
        >
          Architecture
        </a>
        <a
          href="#quickstart"
          className="text-sm text-primary-fixed hover:text-on-surface transition-colors hidden sm:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm"
        >
          Quickstart
        </a>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary-fixed hover:text-on-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm"
        >
          <Github className="w-4 h-4" />
          <span className="hidden sm:inline">GitHub</span>
        </a>
        <Link
          href="/login"
          className="text-sm text-primary-fixed hover:text-on-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/60 focus-visible:ring-offset-2 rounded-sm"
        >
          Log in
        </Link>
      </div>
    </nav>
  );
}
