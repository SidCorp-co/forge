/**
 * The forge plugin this instance serves to `install-plugin.sh` (REQ-25 BC-4): the commit the home
 * project designates for the plugin named `forge` (REQ-26's designation, `lib/plugin-designation.ts`),
 * read through the GitHub App bound to the marketplace repository, cut down to the marketplace
 * (`.claude-plugin/`) and the plugin (`plugin/`).
 *
 * Which designation: the home project's, for every caller. The plugin is one per machine and serves
 * every project its token reaches, so no one of those projects can choose it, and the home project
 * is the instance's own (`forgeHomeProject`), as feedback about Forge is. An unpinned designation
 * follows the default branch, as a box's does, and is read at its commit now.
 *
 * Each commit is fetched once and kept, a few at a time; a commit that cannot be fetched is refused,
 * never answered with another one kept from before.
 */

import { type PluginArchiveRefusalCode, PLUGIN_ARCHIVE_REFUSAL_CODES } from '@forge/contracts/plugins';
import { eq } from 'drizzle-orm';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { db } from '../db/client.js';
import { projects } from '../db/schema-projects.js';
import {
  RepositoryUnreachable,
  repositoryHead,
  repositoryTarball,
} from '../integrations/github/index.js';
import { readPluginDesignations } from '../lib/plugin-designation.js';
import { providerRefused } from '../lib/provider-refusal.js';
import { refuser } from '../lib/refusal.js';
import { readTar, type TarEntry, TarUnreadable, writeTar } from '../lib/tar.js';
import { forgeHomeProject } from './service.js';

const [UNDESIGNATED, UNREACHABLE] = PLUGIN_ARCHIVE_REFUSAL_CODES;
const refuse = refuser<PluginArchiveRefusalCode>(UNDESIGNATED);

/** The plugin `install-plugin.sh` installs, by its name in the marketplace. */
export const FORGE_PLUGIN = 'forge';
/** What the archive carries of the repository: the marketplace and the plugin, nothing else. */
const KEPT = ['.claude-plugin', 'plugin'];
const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';
/** A source tree past this, unpacked, is no plugin; the bound keeps one fetch from filling memory. */
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
/** Commits kept at once: the designated one, and the ones it moved from while boxes catch up. */
const KEPT_COMMITS = 4;

export interface PluginArchive {
  marketplace: string;
  commit: string;
  /** The gzipped tar, rooted at `.claude-plugin/` and `plugin/`. */
  bytes: Buffer;
}

const unzip = promisify(gunzip);
const zip = promisify(gzip);

/** `owner/repo` out of a designation's marketplace, as a box clones it from GitHub. */
function repositoryOf(marketplace: string): { owner: string; repo: string } | null {
  const bare = marketplace
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const m = bare.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

const howToDesignate = (projectId: string) =>
  `Designate it on the home project: PATCH /api/projects/${projectId}/plugins { plugins: [{ marketplace: "<owner>/<repo>", name: "${FORGE_PLUGIN}", pinnedRef: "<commit>" }] }, keeping the plugins it already names.`;

/** The marketplace and commit this instance serves now, or a refusal naming what is not designated. */
async function designated(): Promise<{ marketplace: string; ref: string | null }> {
  const home = await forgeHomeProject();
  if (!home) {
    throw refuse(
      UNDESIGNATED,
      'this Forge instance names no home project, so it designates no forge plugin to serve. An instance admin names one (PATCH /api/admin/instance-settings { baseRevision, patch: { forgeHomeProjectId } }), then designates the plugin there: PATCH /api/projects/<home project id>/plugins.',
    );
  }
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, home.id))
    .limit(1);
  const read = readPluginDesignations(row?.agentConfig ?? null, home.slug);
  if (!read.ok) throw refuse(UNDESIGNATED, `${read.refusal.detail} ${howToDesignate(home.id)}`);
  const forge = read.designations.filter((d) => d.name === FORGE_PLUGIN);
  if (forge.length === 0) {
    const named = read.designations.map((d) => `${d.name} from ${d.marketplace}`).join(', ');
    throw refuse(
      UNDESIGNATED,
      `the home project ${home.slug} designates no plugin named ${FORGE_PLUGIN} (it designates ${named || 'none'}). ${howToDesignate(home.id)}`,
    );
  }
  if (forge.length > 1) {
    throw refuse(
      UNDESIGNATED,
      `the home project ${home.slug} designates ${FORGE_PLUGIN} from ${forge.length} marketplaces (${forge.map((d) => d.marketplace).join(', ')}), so which one to serve is not said. ${howToDesignate(home.id)}`,
    );
  }
  const [only] = forge as [(typeof forge)[number]];
  return { marketplace: only.marketplace, ref: only.pinnedRef ?? null };
}

const unreachable = (marketplace: string, commit: string | null, why: string) =>
  providerRefused(
    `the forge plugin cannot be served from ${marketplace}${commit ? ` at ${commit}` : ''}: ${why}. Nothing else is served in its place.`,
    UNREACHABLE,
  );

/** The repository's tree cut to the marketplace and the plugin, re-rooted at them. */
async function cut(tarball: Buffer): Promise<{ bytes: Buffer; name: string }> {
  let tar: Buffer;
  try {
    tar = await unzip(tarball, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (err) {
    throw new TarUnreadable(`its tarball does not unpack: ${(err as Error).message}`);
  }
  const entries = readTar(tar);
  const top = entries[0]?.path.split('/')[0];
  const kept: TarEntry[] = [];
  for (const e of entries) {
    const rest = e.path.slice((top?.length ?? 0) + 1);
    if (!KEPT.some((k) => rest === k || rest.startsWith(`${k}/`))) continue;
    if (rest.split('/').includes('..')) throw new TarUnreadable(`${rest} climbs out of the tree`);
    if (e.kind !== 'file' && e.kind !== 'dir') {
      throw new TarUnreadable(`${rest} is a ${e.kind}, which the archive does not carry`);
    }
    kept.push({ ...e, path: rest });
  }
  const marketplace = kept.find((e) => e.path === MARKETPLACE_FILE);
  if (!marketplace) throw new TarUnreadable(`the commit holds no ${MARKETPLACE_FILE}`);
  let name: unknown;
  try {
    name = (JSON.parse(marketplace.data.toString('utf8')) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (typeof name !== 'string' || name === '') {
    throw new TarUnreadable(`its ${MARKETPLACE_FILE} names no marketplace`);
  }
  if (!kept.some((e) => e.path.startsWith('plugin/'))) {
    throw new TarUnreadable('the commit holds no plugin/ directory');
  }
  return { bytes: await zip(writeTar(kept)), name };
}

const archives = new Map<string, PluginArchive>();
const fetching = new Map<string, Promise<PluginArchive>>();

function keep(key: string, archive: PluginArchive): void {
  archives.delete(key);
  archives.set(key, archive);
  while (archives.size > KEPT_COMMITS) archives.delete(archives.keys().next().value as string);
}

async function fetchArchive(marketplace: string, commit: string): Promise<PluginArchive> {
  const repository = repositoryOf(marketplace) as { owner: string; repo: string };
  let tarball: Buffer;
  try {
    tarball = await repositoryTarball({ ...repository, commit });
  } catch (err) {
    if (err instanceof RepositoryUnreachable) throw unreachable(marketplace, commit, err.message);
    throw err;
  }
  try {
    return { marketplace, commit, bytes: (await cut(tarball)).bytes };
  } catch (err) {
    if (err instanceof TarUnreadable) throw unreachable(marketplace, commit, err.message);
    throw err;
  }
}

/** The archive of the designated forge plugin commit, or a refusal by name. */
export async function designatedPluginArchive(): Promise<PluginArchive> {
  const { marketplace, ref } = await designated();
  const repository = repositoryOf(marketplace);
  if (!repository) {
    throw unreachable(marketplace, ref, `${marketplace} is no GitHub owner/repo to read it from`);
  }
  let commit = ref;
  if (commit === null) {
    try {
      commit = await repositoryHead(repository);
    } catch (err) {
      if (err instanceof RepositoryUnreachable) throw unreachable(marketplace, null, err.message);
      throw err;
    }
  }
  const key = `${marketplace.toLowerCase()}@${commit}`;
  const held = archives.get(key);
  if (held) {
    keep(key, held);
    return held;
  }
  let pending = fetching.get(key);
  if (!pending) {
    pending = fetchArchive(marketplace, commit).finally(() => fetching.delete(key));
    fetching.set(key, pending);
  }
  const archive = await pending;
  keep(key, archive);
  return archive;
}
