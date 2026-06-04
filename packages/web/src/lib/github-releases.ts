/**
 * GitHub Releases API integration for the /download page.
 *
 * Returns the latest release's metadata + parsed download URLs by platform.
 * Cached at the Next.js fetch layer for 1 hour so the page does not hammer
 * the public API (which has a 60 req/hr unauthenticated limit).
 *
 * If the API is unreachable or no releases exist yet, returns `null` and
 * the page falls back to a "Build from source" CTA.
 */

const REPO = 'SidCorp-co/forge';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

export interface PlatformAsset {
  /** human-readable label, e.g. "macOS (Apple Silicon)" */
  label: string;
  /** lowercase short id, e.g. "macos-arm64" — used as React key */
  id: 'macos-arm64' | 'macos-x64' | 'windows-x64' | 'linux-deb' | 'linux-appimage';
  /** filename, e.g. `Forge_Beta_0.1.7_aarch64.dmg` */
  filename: string;
  /** direct download URL */
  downloadUrl: string;
  /** size in bytes */
  size: number;
  /** SHA-256 hash if a `.sha256` companion asset exists */
  sha256?: string;
}

export interface ReleaseInfo {
  /** e.g. "v0.1.7" */
  tag: string;
  /** e.g. "0.1.7" (no leading v) */
  version: string;
  /** ISO timestamp */
  publishedAt: string;
  /** raw markdown release notes */
  body: string;
  /** GitHub release page URL */
  htmlUrl: string;
  /** parsed downloads keyed by platform id */
  assets: PlatformAsset[];
}

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  body: string;
  html_url: string;
  assets: Array<{
    name: string;
    size: number;
    browser_download_url: string;
  }>;
  draft: boolean;
  prerelease: boolean;
}

function classifyAsset(name: string): PlatformAsset['id'] | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.dmg')) {
    if (lower.includes('aarch64') || lower.includes('arm64')) return 'macos-arm64';
    if (lower.includes('x64') || lower.includes('x86_64')) return 'macos-x64';
    return 'macos-x64'; // generic .dmg → assume Intel
  }
  if (lower.endsWith('.msi') || lower.endsWith('.exe')) return 'windows-x64';
  if (lower.endsWith('.deb')) return 'linux-deb';
  if (lower.endsWith('.appimage')) return 'linux-appimage';
  return null;
}

function platformLabel(id: PlatformAsset['id']): string {
  switch (id) {
    case 'macos-arm64':
      return 'macOS (Apple Silicon)';
    case 'macos-x64':
      return 'macOS (Intel)';
    case 'windows-x64':
      return 'Windows (x86_64)';
    case 'linux-deb':
      return 'Linux (.deb — Debian/Ubuntu)';
    case 'linux-appimage':
      return 'Linux (.AppImage — universal)';
  }
}

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      // Revalidate once per hour. The release artifact list rarely changes
      // mid-day; mid-cycle deploys can use `revalidate=0` query param.
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const release = (await res.json()) as GitHubRelease;
    if (release.draft) return null;

    // Build sha256 map from companion `.sha256` files if present.
    const shaMap = new Map<string, string>();
    for (const asset of release.assets) {
      if (asset.name.endsWith('.sha256')) {
        try {
          const txt = await fetch(asset.browser_download_url, { next: { revalidate: 3600 } });
          if (txt.ok) {
            const body = (await txt.text()).trim().split(/\s+/)[0];
            const targetName = asset.name.replace(/\.sha256$/, '');
            if (body) shaMap.set(targetName, body);
          }
        } catch {
          // Ignore — checksums are nice-to-have.
        }
      }
    }

    const assets: PlatformAsset[] = [];
    const seen = new Set<PlatformAsset['id']>();
    for (const asset of release.assets) {
      const id = classifyAsset(asset.name);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      assets.push({
        id,
        label: platformLabel(id),
        filename: asset.name,
        downloadUrl: asset.browser_download_url,
        size: asset.size,
        sha256: shaMap.get(asset.name),
      });
    }

    return {
      tag: release.tag_name,
      version: release.tag_name.replace(/^v/, ''),
      publishedAt: release.published_at,
      body: release.body ?? '',
      htmlUrl: release.html_url,
      assets,
    };
  } catch {
    return null;
  }
}

export const RELEASES_PAGE_URL = RELEASES_PAGE;
export const REPO_URL = `https://github.com/${REPO}`;
export const ISSUES_URL = `https://github.com/${REPO}/issues`;

// ---------------------------------------------------------------------------
// Forge product CHANGELOG (the in-app "What's New" feed, ISS-384).
//
// The What's New feed is PRODUCT-GLOBAL — it tracks Forge's own releases, not
// the user's selected project. The ISS-305 docs API is per-project (it serves
// `projects.repoPath`), so it cannot supply this. We read Forge's CHANGELOG.md
// raw from GitHub instead — the only product-global source that also carries
// the moving `[Unreleased]` section (the Releases API only lists published
// versions). No new core API is added (honors the issue's reuse constraint).
// ---------------------------------------------------------------------------

const CHANGELOG_RAW_URL = `https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.md`;

export interface ChangelogSection {
  /** Section heading, e.g. "Added" / "Changed" / "Fixed". */
  title: string;
  /** Raw markdown body of the section (its bullet list), rendered as-is. */
  body: string;
}

export interface ChangelogRelease {
  /** Stable identity for the "seen" comparator: the version for a released
   *  entry, or `unreleased:<hash>` for the moving `[Unreleased]` section so the
   *  badge re-appears whenever Unreleased content changes. */
  id: string;
  /** Semver without a leading `v`, or null for `[Unreleased]`. */
  version: string | null;
  /** Release date (`YYYY-MM-DD`) when present in the heading. */
  date: string | null;
  isUnreleased: boolean;
  sections: ChangelogSection[];
}

/**
 * Fetch Forge's product CHANGELOG.md (raw). Cached 1h at the Next fetch layer.
 * Returns `null` on any failure so the screen renders an empty/error state.
 */
export async function fetchForgeChangelog(): Promise<string | null> {
  try {
    const res = await fetch(CHANGELOG_RAW_URL, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Tiny deterministic string hash (djb2 → base36); gives the moving
 *  `[Unreleased]` section a stable-until-its-content-changes identity. */
function hashContent(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const RELEASE_HEADING = /^##\s+\[([^\]]+)\](?:\s*[-–]\s*(.+))?\s*$/;
const SECTION_HEADING = /^###\s+(.+?)\s*$/;

/**
 * Parse a Keep-a-Changelog document into releases. File order is preserved
 * (newest first by convention). Defensive: unrecognized lines attach to the
 * current section body and nothing throws if the format drifts.
 */
export function parseChangelog(md: string): ChangelogRelease[] {
  const lines = md.split(/\r?\n/);
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;

  const closeSection = () => {
    if (current && section) {
      section.body = section.body.trim();
      if (section.body) current.sections.push(section);
    }
    section = null;
  };

  for (const line of lines) {
    const rel = RELEASE_HEADING.exec(line);
    if (rel) {
      closeSection();
      const label = rel[1].trim();
      const isUnreleased = /unreleased/i.test(label);
      current = {
        id: '',
        version: isUnreleased ? null : label.replace(/^v/i, ''),
        date: rel[2]?.trim() || null,
        isUnreleased,
        sections: [],
      };
      releases.push(current);
      continue;
    }
    if (!current) continue; // preamble before the first release heading
    const sec = SECTION_HEADING.exec(line);
    if (sec) {
      closeSection();
      section = { title: sec[1].trim(), body: '' };
      continue;
    }
    if (section) section.body += `${line}\n`;
  }
  closeSection();

  for (const r of releases) {
    if (r.isUnreleased) {
      const content = r.sections.map((s) => `${s.title}\n${s.body}`).join('\n');
      r.id = `unreleased:${hashContent(content)}`;
    } else {
      r.id = r.version ?? `entry:${hashContent(r.sections.map((s) => s.body).join('\n'))}`;
    }
  }
  return releases;
}

/** Identity of the newest entry — what the nav badge compares against the
 *  user's last-seen marker. Null when the changelog is empty/unavailable. */
export function changelogTopId(releases: ChangelogRelease[]): string | null {
  return releases[0]?.id ?? null;
}
