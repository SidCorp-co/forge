import Link from 'next/link';

const REPO_URL = 'https://github.com/SidCorp-co/forge';

export function LandingFooter() {
  return (
    <footer className="bg-surface-container-low border-t border-outline-variant/20">
      <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.32em] text-on-surface">
            <span aria-hidden className="block h-2 w-2 bg-warning" />
            Forge
          </span>
          <span className="text-xs text-primary-fixed">
            &copy; 2026 Forge contributors · Apache-2.0
          </span>
        </div>
        <div className="flex gap-5">
          <Link
            href="/docs"
            className="text-xs text-primary-fixed hover:text-on-surface transition-colors"
          >
            Docs
          </Link>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary-fixed hover:text-on-surface transition-colors"
          >
            GitHub
          </a>
          <a
            href="https://www.apache.org/licenses/LICENSE-2.0"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary-fixed hover:text-on-surface transition-colors"
          >
            License
          </a>
        </div>
      </div>
    </footer>
  );
}
