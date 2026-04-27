import { Apple, Download as DownloadIcon, FileTerminal, Github, Monitor } from 'lucide-react';
import type { PlatformAsset, ReleaseInfo } from '@/lib/github-releases';
import { RELEASES_PAGE_URL, REPO_URL } from '@/lib/github-releases';

function platformIcon(id: PlatformAsset['id']) {
  switch (id) {
    case 'macos-arm64':
    case 'macos-x64':
      return Apple;
    case 'windows-x64':
      return Monitor;
    case 'linux-deb':
    case 'linux-appimage':
      return FileTerminal;
  }
}

interface DownloadPlatformsProps {
  release: ReleaseInfo | null;
}

export function DownloadPlatforms({ release }: DownloadPlatformsProps) {
  if (!release) {
    return (
      <section id="platforms" className="relative max-w-5xl mx-auto px-6 py-24">
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.04)_0%,transparent_70%)]" />
        <div className="text-center mb-10">
          <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
            Platforms
          </p>
          <h2 className="font-serif text-3xl sm:text-4xl tracking-tight mb-4">
            Binaries{' '}
            <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
              coming soon
            </span>
          </h2>
          <p className="text-primary-fixed max-w-md mx-auto text-base font-light leading-relaxed">
            We haven&apos;t cut a tagged release yet. Watch the repo to be the first
            to know — or build from source today.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <a
            href={RELEASES_PAGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] px-6 py-3 text-base font-medium text-white transition-all hover:-translate-y-0.5 shadow-sm"
          >
            <Github className="w-4 h-4" />
            Watch releases on GitHub
          </a>
          <a
            href="#quickstart"
            className="inline-flex items-center gap-1.5 rounded-xl border border-outline-variant/40 bg-white px-6 py-3 text-base font-medium text-on-surface hover:border-outline-variant transition-all"
          >
            Build from source
            <span aria-hidden>→</span>
          </a>
        </div>
      </section>
    );
  }

  return (
    <section id="platforms" className="relative max-w-5xl mx-auto px-6 py-24">
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px] rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.04)_0%,transparent_70%)]" />

      <div className="text-center mb-12">
        <p className="font-mono text-xs tracking-[0.15em] uppercase text-warning mb-3">
          Platforms
        </p>
        <h2 className="font-serif text-3xl sm:text-4xl tracking-tight mb-3">
          Pick your{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            platform
          </span>
        </h2>
        <p className="text-primary-fixed max-w-md mx-auto text-base font-light leading-relaxed">
          Signed builds for every major OS. Tauri verifies the minisign
          signature before each install + auto-update.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {release.assets.map((asset) => {
          const Icon = platformIcon(asset.id);
          return (
            <a
              key={asset.id}
              href={asset.downloadUrl}
              className="group flex items-center gap-4 rounded-2xl border border-outline-variant/20 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="flex w-11 h-11 shrink-0 items-center justify-center rounded-xl bg-warning/10 text-warning">
                <Icon className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-on-surface">{asset.label}</div>
                <div className="mt-0.5 truncate font-mono text-xs text-primary-fixed">
                  {asset.filename}
                </div>
                <div className="mt-1 text-xs text-primary-fixed/70 font-mono">
                  {(asset.size / 1024 / 1024).toFixed(1)} MB
                  {asset.sha256 ? (
                    <>
                      <span className="mx-2 text-outline-variant">·</span>
                      <span>sha256:{asset.sha256.slice(0, 12)}…</span>
                    </>
                  ) : null}
                </div>
              </div>
              <DownloadIcon className="w-4 h-4 shrink-0 text-primary-fixed transition-all group-hover:translate-y-0.5 group-hover:text-warning" />
            </a>
          );
        })}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-mono text-primary-fixed">
        <a
          className="underline-offset-4 hover:underline hover:text-on-surface transition-colors"
          href={release.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          All assets →
        </a>
        <span className="text-outline-variant">·</span>
        <a
          className="underline-offset-4 hover:underline hover:text-on-surface transition-colors"
          href={`${REPO_URL}/blob/main/forge/dev/src-tauri/tauri.conf.json`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Verify pubkey
        </a>
      </div>
    </section>
  );
}
