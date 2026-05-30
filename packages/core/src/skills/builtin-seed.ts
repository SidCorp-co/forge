import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { skills } from '../db/schema.js';
import { logger } from '../logger.js';
import { hashSkillBody } from './hash.js';
import { parseManifest } from './parse-manifest.js';

export interface SeedChange {
  name: string;
  oldVersion: number;
  newVersion: number;
  contentHash: string;
  reason: 'inserted' | 'updated';
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

/**
 * Snapshot of the most recent {@link seedBuiltinSkills} run, exposed via
 * `forge_health` (ISS-7). Excludes `changes` because the per-skill detail is
 * verbose and only meaningful to the boot wiring that just consumed it.
 */
export interface LastSeedSnapshot {
  inserted: number;
  updated: number;
  unchanged: number;
  at: Date;
}

let lastSeedResult: LastSeedSnapshot | null = null;

export function getLastSeedResult(): LastSeedSnapshot | null {
  return lastSeedResult;
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

/**
 * Shape of a single entry persisted into `skills.files` (jsonb). Mirrors the
 * `fileSchema` accepted by the CRUD routes so seeded global skills and
 * user-created project skills share one on-disk representation.
 */
interface SkillFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

/** Skip files larger than this so an accidental large binary cannot bloat the row/hash. */
const MAX_SKILL_FILE_BYTES = 1024 * 1024; // 1 MB

/**
 * Recursively walk a skill folder and load every file except the root
 * `SKILL.md` manifest (which lives in `skill_md`/`prompt`, not `files`) into
 * the `skills.files` shape. Text files are stored utf8 with CRLF normalised so
 * a cross-platform checkout hashes identically; binary files (NUL-byte
 * heuristic) are base64-encoded. The result is sorted by `path` so
 * `hashSkillBody` — which `JSON.stringify`s the array — is order-stable and the
 * seed stays idempotent across boots.
 */
async function collectSkillFiles(skillDir: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    for (const entry of entries) {
      // Skip OS cruft / dotfiles (.DS_Store, .gitkeep, …) so they never pollute
      // the content hash.
      if (entry.name.startsWith('.')) continue;

      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) continue;

      // The root manifest is stored separately; never duplicate it into files[].
      if (dir === skillDir && entry.name === 'SKILL.md') continue;

      const buf = await readFile(absPath);
      const relPath = path.relative(skillDir, absPath).split(path.sep).join('/');

      if (buf.byteLength > MAX_SKILL_FILE_BYTES) {
        logger.warn(
          { skillDir, file: relPath, bytes: buf.byteLength, cap: MAX_SKILL_FILE_BYTES },
          'collectSkillFiles: skipping oversized skill file',
        );
        continue;
      }

      const isBinary = buf.includes(0);
      if (isBinary) {
        files.push({ path: relPath, content: buf.toString('base64'), encoding: 'base64' });
      } else {
        files.push({
          path: relPath,
          content: buf.toString('utf8').replace(/\r\n/g, '\n'),
          encoding: 'utf8',
        });
      }
    }
  }

  await walk(skillDir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
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

    // Walk references/, scripts/, … into files[] and hash over the full folder
    // (skillMd + files) using the SAME function the CRUD routes use, so seeded
    // global skills and user-edited skills compute identical hashes for
    // identical content.
    const files = await collectSkillFiles(path.join(root, entry.name));
    const contentHash = hashSkillBody(rawText, files);
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
      })
      .from(skills)
      .where(and(eq(skills.name, name), eq(skills.scope, 'global')))
      .limit(1);
    const current = existing[0];

    if (!current) {
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
        files: files as never,
      });
      result.inserted += 1;
      result.changes.push({
        name,
        oldVersion: 0,
        newVersion: 1,
        contentHash,
        reason: 'inserted',
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
    const skillMdMissing = !current.skillMd;
    const hashMatches = current.contentHash === contentHash || current.contentHash === saltedHash;
    if (hashMatches && !skillMdMissing) {
      result.unchanged += 1;
      continue;
    }

    // Bump version only when the underlying content actually changed; a pure
    // skill_md backfill (hash already matches) re-renders bytes without
    // signalling a logical update to clients.
    const versionChanged = !hashMatches;
    const writeContentHash = skillMdMissing && !versionChanged ? saltedHash : contentHash;
    const newVersion = versionChanged ? current.version + 1 : current.version;
    await db
      .update(skills)
      .set({
        description,
        prompt,
        tools,
        manifest: frontmatter,
        contentHash: writeContentHash,
        skillMd: rawText,
        files: files as never,
        version: newVersion,
        updatedAt: sql`now()`,
      })
      .where(and(eq(skills.name, name), eq(skills.scope, 'global')));
    result.updated += 1;
    if (versionChanged) {
      result.changes.push({
        name,
        oldVersion: current.version,
        newVersion,
        contentHash,
        reason: 'updated',
      });
    }
  }

  if (result.updated > 0 || result.inserted > 0) {
    logger.info({ ...result }, 'seedBuiltinSkills: built-in skills seeded');
  } else {
    logger.debug({ ...result }, 'seedBuiltinSkills: all built-in skills up to date');
  }

  lastSeedResult = {
    inserted: result.inserted,
    updated: result.updated,
    unchanged: result.unchanged,
    at: new Date(),
  };

  return result;
}
