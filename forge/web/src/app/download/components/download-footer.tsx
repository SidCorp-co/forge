import { ISSUES_URL, REPO_URL, type ReleaseInfo } from '@/lib/github-releases';

interface DownloadFooterProps {
  release: ReleaseInfo | null;
}

const links = [
  { label: 'GitHub', href: REPO_URL },
  { label: 'Issues', href: ISSUES_URL },
  {
    label: 'License',
    href: `${REPO_URL}/blob/main/LICENSE`,
  },
  {
    label: 'CHANGELOG',
    href: `${REPO_URL}/blob/main/CHANGELOG.md`,
  },
  {
    label: 'Docs',
    href: `${REPO_URL}/tree/main/docs`,
  },
];

export function DownloadFooter({ release }: DownloadFooterProps) {
  return (
    <footer className="bg-surface-container-lowest/60">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-serif text-lg tracking-tight text-on-surface">Forge Beta</p>
            <p className="mt-1 text-xs text-on-surface-variant">
              Apache-2.0 licensed
              {release ? (
                <>
                  <span className="mx-2">·</span>
                  <span className="font-mono">{release.tag}</span>
                  <span className="mx-2">·</span>
                  released {new Date(release.publishedAt).toLocaleDateString()}
                </>
              ) : (
                <>
                  <span className="mx-2">·</span>
                  pre-release
                </>
              )}
            </p>
          </div>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-on-surface-variant transition-colors hover:text-on-surface"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
        <p className="mt-8 text-xs text-outline">
          © {new Date().getFullYear()} junixlabs · Built with Forge
        </p>
      </div>
    </footer>
  );
}
