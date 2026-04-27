'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Download as DownloadIcon, Github, Terminal } from 'lucide-react';
import type { PlatformAsset, ReleaseInfo } from '@/lib/github-releases';
import { REPO_URL } from '@/lib/github-releases';

function detectPlatformId(): PlatformAsset['id'] | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  const platform = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData
    ?.platform ?? navigator.platform ?? '';
  if (/Mac|iPhone|iPad/i.test(platform) || /Mac OS X/i.test(ua)) {
    // Apple Silicon detection is best-effort. Modern WebKit reports
    // "MacIntel" even on M-series; the safest signal is GPU renderer
    // string but we avoid the WebGL probe noise. Default to ARM (which
    // covers all Macs sold since 2020) and let the user pick Intel
    // explicitly from the platform grid if needed.
    return 'macos-arm64';
  }
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows-x64';
  if (/Linux/i.test(platform) || /X11/i.test(ua)) return 'linux-deb';
  return null;
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

  return (
    <section className="relative overflow-hidden border-b border-outline-variant/30">
      {/* Ambient gradient backdrop */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.08),transparent_60%)]" />
      <div className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.15),transparent_70%)] blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.12),transparent_70%)] blur-3xl" />

      <div className="relative mx-auto max-w-5xl px-6 py-20 sm:py-28">
        {/* version badge */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-outline-variant/40 bg-surface-container-low/60 px-3 py-1 text-xs text-on-surface-variant backdrop-blur">
          <span className="size-1.5 rounded-full bg-success" />
          {release ? (
            <>
              Latest&nbsp;<span className="font-mono">{release.tag}</span>
              <span className="text-outline">·</span>
              Apache-2.0
            </>
          ) : (
            <>Coming soon · Apache-2.0</>
          )}
        </div>

        <h1 className="text-balance font-serif text-4xl tracking-tight sm:text-6xl">
          Open-source control plane for{' '}
          <span className="bg-gradient-to-r from-[#a8d4ff] to-[#82c4f8] bg-clip-text text-transparent">
            Claude Code
          </span>
        </h1>

        <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-on-surface-variant sm:text-lg">
          Forge Beta is a desktop app that orchestrates AI agents across your projects.
          Pipeline-driven issue tracking, pluggable runners, MCP-native — running
          locally on your machine with your own Claude subscription.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          {recommended ? (
            <a
              href={recommended.downloadUrl}
              className="group inline-flex items-center gap-2 rounded-md bg-[linear-gradient(135deg,#ffffff_0%,#d4d4d4_100%)] px-6 py-3 text-base font-semibold text-on-primary shadow-lg shadow-black/30 transition-transform hover:-translate-y-0.5 active:translate-y-0"
              data-platform={recommended.id}
            >
              <DownloadIcon className="size-4" />
              Download for {recommended.label}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </a>
          ) : (
            <Link
              href="#platforms"
              className="group inline-flex items-center gap-2 rounded-md bg-[linear-gradient(135deg,#ffffff_0%,#d4d4d4_100%)] px-6 py-3 text-base font-semibold text-on-primary shadow-lg shadow-black/30 transition-transform hover:-translate-y-0.5 active:translate-y-0"
            >
              <DownloadIcon className="size-4" />
              {release ? 'See platforms' : 'Build from source'}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          )}

          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-outline-variant/50 bg-surface-container-low/60 px-6 py-3 text-base font-medium text-on-surface backdrop-blur transition-colors hover:bg-surface-container"
          >
            <Github className="size-4" />
            View on GitHub
          </a>

          <a
            href="#quickstart"
            className="inline-flex items-center gap-2 rounded-md px-4 py-3 text-sm font-medium text-on-surface-variant transition-colors hover:text-on-surface"
          >
            <Terminal className="size-4" />
            Quickstart
          </a>
        </div>

        {recommended && release && (
          <p className="mt-4 text-xs text-outline">
            <span className="font-mono">{recommended.filename}</span>
            <span className="mx-2">·</span>
            {(recommended.size / 1024 / 1024).toFixed(1)} MB
            <span className="mx-2">·</span>
            Released {new Date(release.publishedAt).toLocaleDateString()}
          </p>
        )}
      </div>
    </section>
  );
}
