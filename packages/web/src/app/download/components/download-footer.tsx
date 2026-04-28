import Link from 'next/link';
import { ISSUES_URL, REPO_URL, type ReleaseInfo } from '@/lib/github-releases';

interface DownloadFooterProps {
  release: ReleaseInfo | null;
}

const externalLinks = [
  { label: 'GitHub', href: REPO_URL },
  { label: 'Issues', href: ISSUES_URL },
  { label: 'License', href: `${REPO_URL}/blob/main/LICENSE` },
  { label: 'CHANGELOG', href: `${REPO_URL}/blob/main/CHANGELOG.md` },
  { label: 'Docs', href: `${REPO_URL}/tree/main/docs` },
];

export function DownloadFooter({ release }: DownloadFooterProps) {
  return (
    <footer className="border-t border-outline-variant/20 bg-white">
      <div className="mx-auto max-w-5xl px-6 py-14">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-serif text-2xl tracking-tight text-on-surface">
              Forge Beta
            </p>
            <p className="mt-2 text-xs text-primary-fixed font-mono">
              <span className="text-on-surface">Apache-2.0</span>
              {release ? (
                <>
                  <span className="mx-2 text-outline-variant">·</span>
                  <span className="text-on-surface">{release.tag}</span>
                  <span className="mx-2 text-outline-variant">·</span>
                  <span>released {new Date(release.publishedAt).toLocaleDateString()}</span>
                </>
              ) : (
                <>
                  <span className="mx-2 text-outline-variant">·</span>
                  pre-release
                </>
              )}
            </p>
            <p className="mt-3 text-xs text-primary-fixed font-light max-w-sm leading-relaxed">
              Built by{' '}
              <Link
                href="/"
                className="underline-offset-4 hover:underline hover:text-on-surface transition-colors"
              >
                SidCorp
              </Link>{' '}
              — POC studio shipping fast with the same toolkit you&apos;re downloading.
            </p>
          </div>

          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {externalLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-fixed transition-colors hover:text-on-surface"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-10 pt-6 border-t border-outline-variant/20 text-xs text-primary-fixed/80 flex flex-wrap items-center justify-between gap-2">
          <span>© {new Date().getFullYear()} junixlabs · Built with Forge</span>
          <Link href="/" className="hover:text-on-surface transition-colors">
            ← Back to studio
          </Link>
        </div>
      </div>
    </footer>
  );
}
