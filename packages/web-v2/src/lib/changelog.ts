
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
