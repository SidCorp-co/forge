// Forge product CHANGELOG parsing for the in-app "What's New" feed (ISS-384).
//
// PRODUCT-GLOBAL source: the feed tracks Forge's own releases, not the user's
// selected project, so it cannot use the per-project ISS-305 docs API. We read
// Forge's CHANGELOG.md raw from GitHub — the only product-global source that
// also carries the moving `[Unreleased]` section. No new core API is added.
//
// This mirrors `packages/web/src/lib/github-releases.ts` (the two Next apps
// don't share a runtime package, same as the duplicated `markdown` component);
// keep the parser shape identical so the UX can't diverge.

const REPO = "SidCorp-co/forge";
const CHANGELOG_RAW_URL = `https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.md`;

export const FORGE_RELEASES_URL = `https://github.com/${REPO}/releases`;

export interface ChangelogSection {
  /** Section heading, e.g. "Added" / "Changed" / "Fixed". */
  title: string;
  /** Raw markdown body of the section (its bullet list), rendered as-is. */
  body: string;
}

export interface ChangelogRelease {
  /** Stable identity for the "seen" comparator: the version for a released
   *  entry, or `unreleased:<hash>` for the moving `[Unreleased]` section. */
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
        id: "",
        version: isUnreleased ? null : label.replace(/^v/i, ""),
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
      section = { title: sec[1].trim(), body: "" };
      continue;
    }
    if (section) {
      section.body += `${line}\n`;
    } else if (line.trim()) {
      // Flat (Claude-Code-style) release notes — 0.2.12 onwards have no
      // `###` subsections: a headline line + flat bullets. Collect them
      // into an untitled section so the feed renders them as-is.
      section = { title: "", body: `${line}\n` };
    }
  }
  closeSection();

  for (const r of releases) {
    if (r.isUnreleased) {
      const content = r.sections.map((s) => `${s.title}\n${s.body}`).join("\n");
      r.id = `unreleased:${hashContent(content)}`;
    } else {
      r.id = r.version ?? `entry:${hashContent(r.sections.map((s) => s.body).join("\n"))}`;
    }
  }
  return releases;
}

/** Identity of the newest entry — what the nav badge compares against the
 *  user's last-seen marker. Null when the changelog is empty/unavailable. */
export function changelogTopId(releases: ChangelogRelease[]): string | null {
  return releases[0]?.id ?? null;
}
