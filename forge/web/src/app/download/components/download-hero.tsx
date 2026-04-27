'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Download as DownloadIcon, Github, Terminal } from 'lucide-react';
import type { PlatformAsset, ReleaseInfo } from '@/lib/github-releases';
import { REPO_URL, RELEASES_PAGE_URL } from '@/lib/github-releases';

function detectPlatformId(): PlatformAsset['id'] | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  if (/Mac|iPhone|iPad/i.test(platform) || /Mac OS X/i.test(ua)) {
    return 'macos-arm64';
  }
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows-x64';
  if (/Linux/i.test(platform) || /X11/i.test(ua)) return 'linux-deb';
  return null;
}

function platformShortName(id: PlatformAsset['id'] | null): string {
  if (!id) return 'your platform';
  switch (id) {
    case 'macos-arm64':
    case 'macos-x64':
      return 'macOS';
    case 'windows-x64':
      return 'Windows';
    case 'linux-deb':
    case 'linux-appimage':
      return 'Linux';
  }
}

interface DownloadHeroProps {
  release: ReleaseInfo | null;
}

export function DownloadHero({ release }: DownloadHeroProps) {
  const [platformId, setPlatformId] = useState<PlatformAsset['id'] | null>(null);

  useEffect(() => {
    setPlatformId(detectPlatformId());
  }, []);

  const recommended = useMemo<PlatformAsset | null>(() => {
    if (!release || !platformId) return null;
    return release.assets.find((a) => a.id === platformId) ?? release.assets[0] ?? null;
  }, [release, platformId]);

  // Always-visible primary CTA. When a release exists with a binary for the
  // detected OS, link straight to the file. Otherwise route to the GitHub
  // Releases page so the visitor still has a tangible next step (watch the
  // repo, build from source, or wait for v0.1.7).
  const primary = recommended
    ? {
        href: recommended.downloadUrl,
        label: `Download for ${platformShortName(platformId)}`,
        sub: `${recommended.filename} · ${(recommended.size / 1024 / 1024).toFixed(1)} MB`,
        target: undefined as string | undefined,
      }
    : {
        href: RELEASES_PAGE_URL,
        label: 'Get Forge Beta on GitHub',
        sub: 'First tagged release coming soon — watch the repo for v0.1.7',
        target: '_blank',
      };

  return (
    <section className="relative overflow-hidden border-b border-outline-variant/20">
      {/* Soft radial glows — same vocabulary as the landing hero/forge sections */}
      <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[900px] h-[600px] rounded-full bg-[radial-gradient(ellipse,rgba(249,115,22,0.07)_0%,rgba(249,115,22,0.02)_40%,transparent_75%)]" />
      <div className="pointer-events-none absolute bottom-0 right-[-15%] w-[500px] h-[500px] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.05)_0%,transparent_70%)]" />

      <div className="relative mx-auto max-w-5xl px-6 pt-28 pb-20 text-center">
        {/* Eyebrow badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-outline-variant/40 bg-white/80 backdrop-blur-sm px-4 py-1.5 text-xs text-primary-fixed font-mono tracking-wide mb-8 shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
          {release ? (
            <>
              Latest&nbsp;<span className="font-semibold text-on-surface">{release.tag}</span>
              <span className="mx-1 text-outline-variant">·</span>
              Apache-2.0
            </>
          ) : (
            <>Pre-release · Apache-2.0</>
          )}
        </div>

        {/* Headline — matches landing's serif/light treatment */}
        <h1 className="font-serif text-5xl sm:text-6xl md:text-7xl tracking-tight leading-[1.05] mb-6">
          <span className="text-on-surface">Download</span>{' '}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
            Forge Beta
          </span>
          <br />
          <span className="text-on-surface text-3xl sm:text-4xl md:text-5xl font-light">
            on your machine
          </span>
        </h1>

        <p className="text-lg sm:text-xl text-primary-fixed max-w-xl mx-auto font-light leading-relaxed mb-12">
          Open-source control plane for Claude Code. Local-first runner, pluggable
          adapters, MCP-native — orchestration that respects your stack.
        </p>

        {/* Primary CTA — always visible, big, amber gradient (matches landing) */}
        <div className="flex flex-col items-center gap-5">
          <a
            href={primary.href}
            target={primary.target}
            rel={primary.target ? 'noopener noreferrer' : undefined}
            className="group inline-flex items-center gap-3 rounded-xl bg-[linear-gradient(135deg,#855300_0%,#f59e0b_100%)] px-9 py-5 font-medium text-white text-lg sm:text-xl transition-all hover:-translate-y-0.5 shadow-[0_4px_24px_rgba(133,83,0,0.28)] hover:shadow-[0_10px_40px_rgba(133,83,0,0.4)]"
          >
            <DownloadIcon className="w-5 h-5" />
            {primary.label}
            <span
              aria-hidden
              className="transition-transform group-hover:translate-x-0.5 text-white/80"
            >
              →
            </span>
          </a>
          <p className="font-mono text-xs text-primary-fixed">{primary.sub}</p>

          {/* Secondary actions */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-primary-fixed hover:text-on-surface transition-colors group/link"
            >
              <Github className="w-4 h-4" />
              <span>View source on GitHub</span>
              <ArrowUpRight className="w-3.5 h-3.5 transition-transform group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5" />
            </a>
            <Link
              href="#quickstart"
              className="inline-flex items-center gap-1.5 text-primary-fixed hover:text-on-surface transition-colors"
            >
              <Terminal className="w-4 h-4" />
              <span>Read quickstart</span>
            </Link>
          </div>
        </div>

        {release && recommended && (
          <p className="mt-12 text-xs text-primary-fixed/80 font-mono">
            Released {new Date(release.publishedAt).toLocaleDateString()}
            <span className="mx-2 text-outline-variant">·</span>
            <Link href="#platforms" className="underline-offset-4 hover:underline hover:text-on-surface transition-colors">
              See all platforms
            </Link>
          </p>
        )}
      </div>
    </section>
  );
}
