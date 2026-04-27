import Script from 'next/script';
import { fetchLatestRelease } from '@/lib/github-releases';
import { DownloadHero } from './components/download-hero';
import { DownloadPlatforms } from './components/download-platforms';
import { DownloadFeatures } from './components/download-features';
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
      <main className="min-h-full">
        <DownloadHero release={release} />
        <DownloadPlatforms release={release} />
        <DownloadFeatures />
        <DownloadQuickstart release={release} />
        <DownloadFooter release={release} />
      </main>
    </>
  );
}
