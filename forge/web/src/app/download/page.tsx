import Script from 'next/script';
import { fetchLatestRelease } from '@/lib/github-releases';
import { DownloadHero } from './components/download-hero';
import { DownloadPlatforms } from './components/download-platforms';
import { DownloadFeatures } from './components/download-features';
import { DownloadComparison } from './components/download-comparison';
import { DownloadArchitecture } from './components/download-architecture';
import { DownloadQuickstart } from './components/download-quickstart';
import { DownloadFooter } from './components/download-footer';

export const revalidate = 3600;

export default async function DownloadPage() {
  const release = await fetchLatestRelease();

  // JSON-LD SoftwareApplication structured data — improves SEO + lets
  // Google/Bing render rich install cards when the page is shared.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Forge Beta',
    operatingSystem: 'macOS, Windows, Linux',
    applicationCategory: 'DeveloperApplication',
    softwareVersion: release?.version ?? 'unreleased',
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    description:
      'Open-source desktop app for project management + AI agent orchestration with Claude Code.',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    downloadUrl: release?.htmlUrl,
  };

  return (
    <>
      <Script
        id="ld-software-app"
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured data
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/*
        Alternating section backgrounds break the white-on-white wash that
        was making cards float without anchor. The pattern is:
            white  → hero (with radial glows)
            tinted → platforms
            white  → features (cards stand out)
            tinted → comparison (table reads as a "different surface")
            white  → architecture (SVG diagram has breathing room)
            tinted → quickstart (steps feel grouped)
            white  → footer
        Tint = surface-container-low/40 — barely-there but enough to give
        the page rhythm and depth.
      */}
      <main className="min-h-full">
        <DownloadHero release={release} />
        <div className="bg-surface-container-low/40">
          <DownloadPlatforms release={release} />
        </div>
        <DownloadFeatures />
        <div className="bg-surface-container-low/40">
          <DownloadComparison />
        </div>
        <DownloadArchitecture />
        <div className="bg-surface-container-low/40">
          <DownloadQuickstart release={release} />
        </div>
        <DownloadFooter release={release} />
      </main>
    </>
  );
}
