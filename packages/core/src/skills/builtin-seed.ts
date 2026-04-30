import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { skills } from '../db/schema.js';
import { logger } from '../logger.js';
import { parseManifest } from './parse-manifest.js';

export interface SkillChangelogEntry {
  at: string;
  version: number;
  reason: 'inserted' | 'updated';
  contentHash: string;
}

export interface SeedChange {
  name: string;
  oldVersion: number;
  newVersion: number;
  contentHash: string;
  reason: 'inserted' | 'updated';
  changelog: SkillChangelogEntry;
}

export interface SeedResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /**
   * Per-skill change records for callers (e.g. boot wiring) that need to
   * broadcast a `globalSkillUpdated` hook for each genuine content change.
   * Excludes the stale-`skill_md` backfill where `contentHash` already
   * matched the existing row — that path re-renders bytes without
   * signalling a logical update to clients.
   */
  changes: SeedChange[];
}

export interface SeedOptions {
  /**
   * Override the directory scanned for `forge-*` subdirectories. Defaults to
   * the `skills/` folder shipped alongside the compiled package.
   */
  skillsRoot?: string;
}

const BUILTIN_SKILL_PREFIX = 'forge-';

function defaultSkillsRoot(): string {
  // Resolves to `<pkg-root>/skills` whether running from `src/skills/` (dev,
  // tsx) or `dist/skills/` (prod, node). The post-build copy puts skills next
  // to `dist/`, matching the same relative distance.
  return fileURLToPath(new URL('../../skills/', import.meta.url));
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256')
    .update(typeof buf === 'string' ? Buffer.from(buf) : buf)
    .digest('hex');
}

export async function seedBuiltinSkills(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const root = options.skillsRoot ?? defaultSkillsRoot();

  let entries: Dirent[];
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    logger.error({ err, root }, 'seedBuiltinSkills: cannot read skills directory');
    throw err;
  }

  const result: SeedResult = { inserted: 0, updated: 0, unchanged: 0, changes: [] };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(BUILTIN_SKILL_PREFIX)) continue;

    const skillMdPath = path.join(root, entry.name, 'SKILL.md');
    let raw: Buffer;
    try {
      raw = await readFile(skillMdPath);
    } catch (err) {
      throw new Error(`seedBuiltinSkills: missing SKILL.md at ${skillMdPath}`, { cause: err });
    }

    // Normalise line endings before hashing + parsing so a cross-platform
    // checkout (Windows with core.autocrlf) does not produce a different hash
    // from Linux CI, which would otherwise look like a content change on every
    // boot and bump `version` spuriously.
    const rawText = raw.toString('utf8').replace(/\r\n/g, '\n');
    const { frontmatter, body } = parseManifest(rawText);

    const name = frontmatter.name;
    const description = frontmatter.description;
    if (typeof name !== 'string' || !name) {
      throw new Error(`seedBuiltinSkills: ${entry.name}/SKILL.md missing frontmatter "name"`);
    }
    if (typeof description !== 'string' || !description) {
      throw new Error(
        `seedBuiltinSkills: ${entry.name}/SKILL.md missing frontmatter "description"`,
      );
    }

    const toolsRaw = frontmatter.tools;
    const tools = Array.isArray(toolsRaw) ? toolsRaw : [];

    const contentHash = sha256(rawText);
    const prompt = body;

    // Look up the current row (if any) and decide insert / update / unchanged.
    // ISS-2: also pull `skill_md` so we can detect rows seeded by an older
    // build that hashed the full file but only persisted `prompt` (body),
    // leaving `skill_md` null. Those rows must re-emit content even when
    // contentHash already matches.
    const existing = await db
      .select({
        contentHash: skills.contentHash,
        version: skills.version,
        skillMd: skills.skillMd,
        changelog: skills.changelog,
      })
      .from(skills)
      .where(and(eq(skills.name, name), eq(skills.scope, 'global')))
      .limit(1);
    const current = existing[0];

    if (!current) {
      const entry: SkillChangelogEntry = {
        at: new Date().toISOString(),
        version: 1,
        reason: 'inserted',
        contentHash,
      };
      await db.insert(skills).values({
        name,
        description,
        scope: 'global',
        projectId: null,
        prompt,
        tools,
        manifest: frontmatter,
        source: 'builtin',
        version: 1,
        contentHash,
        skillMd: rawText,
        changelog: [entry],
      });
      result.inserted += 1;
      result.changes.push({
        name,
        oldVersion: 0,
        newVersion: 1,
        contentHash,
        reason: 'inserted',
        changelog: entry,
      });
      continue;
    }

    // ISS-2A: when the row's `skill_md` was null but `contentHash` matched
    // the file, the desktop sync daemon's locally-cached hash equals the
    // server hash and it short-circuits the install — leaving the local
    // SKILL.md file empty even though the DB now has content. To force a
    // one-time daemon resync, the backfill writes a salted hash that
    // differs from the daemon's cached value. The salt is deterministic
    // so once applied the row converges (subsequent boots accept either
    // the natural or the salted hash as "current content").
    const saltedHash = sha256(`backfill-iss2a:${rawText}`);
    const naturalMatches = current.contentHash === contentHash;
    const saltedMatches = current.contentHash === saltedHash;
    const skillMdMissing = !current.skillMd;

    if (naturalMatches && !skillMdMissing) {
      result.unchanged += 1;
      continue;
    }

    // Convergence: the row was previously backfilled with the salted hash
    // (skillMd is now non-null and the daemon has long since resynced).
    // Quietly write the natural hash back so downstream consumers that
    // recompute sha256(rawText) see a consistent value. No version bump,
    // no change record — bytes are identical and clients already hold the
    // correct content.
    if (saltedMatches && !skillMdMissing) {
      await db
        .update(skills)
        .set({
          contentHash,
          updatedAt: sql`now()`,
        })
        .where(and(eq(skills.name, name), eq(skills.scope, 'global')));
      result.unchanged += 1;
      // One-time per skill per device: dev daemons cached the salted hash
      // from the prior boot, so the natural-hash convergence will trigger
      // a single redundant `GET /skills/effective` refetch on next poll.
      // Log so operators expect the post-deploy refetch spike rather than
      // mistaking it for an unrelated content churn.
      logger.info(
        { name, saltedHash, naturalHash: contentHash },
        'seedBuiltinSkills: converged salted→natural hash (expect one-time daemon refetch)',
      );
      continue;
    }

    // Bump version only when the underlying content actually changed; a pure
    // skill_md backfill (hash already matches) re-renders bytes without
    // signalling a logical update to clients.
    const versionChanged = !naturalMatches && !saltedMatches;
    const writeContentHash = skillMdMissing && !versionChanged ? saltedHash : contentHash;
    const newVersion = versionChanged ? current.version + 1 : current.version;
    const existingChangelog = Array.isArray(current.changelog)
      ? (current.changelog as SkillChangelogEntry[])
      : [];
    let newEntry: SkillChangelogEntry | null = null;
    if (versionChanged) {
      newEntry = {
        at: new Date().toISOString(),
        version: newVersion,
        reason: 'updated',
        contentHash,
      };
    }
    await db
      .update(skills)
      .set({
        description,
        prompt,
        tools,
        manifest: frontmatter,
        contentHash: writeContentHash,
        skillMd: rawText,
        version: newVersion,
        ...(newEntry ? { changelog: [...existingChangelog, newEntry] } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(skills.name, name), eq(skills.scope, 'global')));
    result.updated += 1;
    if (versionChanged && newEntry) {
      result.changes.push({
        name,
        oldVersion: current.version,
        newVersion,
        contentHash,
        reason: 'updated',
        changelog: newEntry,
      });
    }
  }

  if (result.updated > 0 || result.inserted > 0) {
    logger.info({ ...result }, 'seedBuiltinSkills: built-in skills seeded');
  } else {
    logger.debug({ ...result }, 'seedBuiltinSkills: all built-in skills up to date');
  }

  return result;
}
