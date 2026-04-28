import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { ForceLightTheme } from '@/components/force-light-theme';
import { REPO_URL } from '@/lib/github-releases';
import { SITE_URL } from '@/lib/site-url';

const DOWNLOAD_URL = `${SITE_URL}/download`;

export const metadata: Metadata = {
  title: 'Download Forge Beta — Open-source control plane for Claude Code',
  description:
    'Free, Apache-2.0 licensed desktop app for project management + AI agent orchestration. Local-first runner, pluggable adapters, MCP-native. Available for macOS, Windows, and Linux.',
  openGraph: {
    title: 'Download Forge Beta',
    description:
      'Open-source desktop app for project management + Claude Code orchestration. macOS, Windows, Linux.',
    url: DOWNLOAD_URL,
    siteName: 'Forge Beta',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Download Forge Beta',
    description:
      'Open-source desktop app for project management + Claude Code orchestration.',
  },
  alternates: {
    canonical: DOWNLOAD_URL,
  },
  other: {
    'github:repo': REPO_URL,
  },
};

export default function DownloadLayout({ children }: { children: ReactNode }) {
  // Light theme to stay consistent with the SidCorp landing — Forge is the
  // engine surfaced on the marketing site, so the download page inherits the
  // same editorial-luxury palette (white + amber gradient + soft radial glows).
  // ForceLightTheme overrides the user's saved next-themes preference for
  // the duration of this layout (restored on unmount).
  return (
    <>
      <ForceLightTheme />
      <div data-theme="light" className="fixed inset-0 overflow-y-auto bg-background text-on-surface">
        {children}
      </div>
    </>
  );
}
