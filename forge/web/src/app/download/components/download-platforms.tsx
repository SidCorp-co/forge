import { Apple, Download as DownloadIcon, FileTerminal, Monitor } from 'lucide-react';
import type { PlatformAsset, ReleaseInfo } from '@/lib/github-releases';
import { RELEASES_PAGE_URL } from '@/lib/github-releases';

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
      <section id="platforms" className="border-b border-outline-variant/30">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <h2 className="font-serif text-3xl tracking-tight">No prebuilt binaries yet</h2>
          <p className="mt-4 max-w-prose text-on-surface-variant">
            We haven&apos;t cut a tagged release yet. You can still build Forge Beta
            from source — see the{' '}
            <a className="text-[#82c4f8] underline hover:text-[#a8d4ff]" href="#quickstart">
              quickstart below
            </a>{' '}
            or browse the{' '}
            <a
              className="text-[#82c4f8] underline hover:text-[#a8d4ff]"
              href={RELEASES_PAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              releases page
            </a>
            .
          </p>
        </div>
      </section>
    );
  }

  return (
    <section id="platforms" className="border-b border-outline-variant/30">
      <div className="mx-auto max-w-5xl px-6 py-20">
        <div className="mb-10 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="mb-2 font-mono text-xs uppercase tracking-[0.15em] text-on-surface-variant">
              Downloads
            </p>
            <h2 className="font-serif text-3xl tracking-tight sm:text-4xl">
              Pick your platform
            </h2>
          </div>
          <a
            className="text-sm text-on-surface-variant underline hover:text-on-surface"
            href={release.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            All assets on GitHub →
          </a>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {release.assets.map((asset) => {
            const Icon = platformIcon(asset.id);
            return (
              <a
                key={asset.id}
                href={asset.downloadUrl}
                className="group flex items-center gap-4 rounded-lg border border-outline-variant/40 bg-surface-container-low/60 p-5 transition-colors hover:border-outline-variant hover:bg-surface-container"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-container-high text-on-surface">
                  <Icon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-on-surface">{asset.label}</div>
                  <div className="mt-0.5 truncate font-mono text-xs text-on-surface-variant">
                    {asset.filename}
                  </div>
                  <div className="mt-1 text-xs text-outline">
                    {(asset.size / 1024 / 1024).toFixed(1)} MB
                    {asset.sha256 ? (
                      <>
                        <span className="mx-2">·</span>
                        <span className="font-mono">sha256:{asset.sha256.slice(0, 12)}…</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <DownloadIcon className="size-4 shrink-0 text-on-surface-variant transition-transform group-hover:translate-y-0.5" />
              </a>
            );
          })}
        </div>

        <p className="mt-6 text-xs text-outline">
          Binaries are signed with our public minisign key (committed at
          {' '}
          <span className="font-mono">forge/dev/src-tauri/tauri.conf.json</span>);
          Tauri verifies the signature before installing each update. You can
          additionally verify the .sha256 companion files on the GitHub release page.
        </p>
      </div>
    </section>
  );
}
