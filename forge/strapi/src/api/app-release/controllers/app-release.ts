import { factories } from '@strapi/strapi';
import { createReadStream } from 'fs';
import path from 'path';

const UID = 'api::app-release.app-release' as any;

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export default factories.createCoreController(UID, ({ strapi }) => ({
  /**
   * GET /api/app-releases/check/:target/:currentVersion
   * Tauri v2 updater endpoint — returns 204 (no update) or 200 with update JSON.
   */
  async check(ctx) {
    const { target: rawTarget, currentVersion } = ctx.params;

    // Normalize Tauri target names to our platform convention
    // Tauri sends: "windows", "linux", "darwin"
    // We store: "windows-x86_64", "linux-x86_64", "darwin-x86_64" / "darwin-aarch64"
    const TARGET_MAP: Record<string, string> = {
      windows: 'windows-x86_64',
      linux: 'linux-x86_64',
      darwin: 'darwin-x86_64',
    };
    const target = TARGET_MAP[rawTarget] || rawTarget;
    strapi.log.info(`[app-release.check] target=${rawTarget}→${target} currentVersion=${currentVersion}`);

    const releases: any[] = await strapi.documents(UID).findMany({
      filters: {
        platform: target,
        isCurrent: true,
      },
      status: 'published',
      populate: ['binary'],
    });

    const release = releases[0];
    if (!release || compareVersions(release.version, currentVersion) <= 0) {
      strapi.log.info(`[app-release.check] → 204 (no update) found=${!!release} version=${release?.version}`);
      ctx.status = 204;
      return;
    }
    strapi.log.info(`[app-release.check] → 200 update available: ${release.version}`);

    const binary = Array.isArray(release.binary) ? release.binary[0] : release.binary;
    if (!binary) {
      ctx.status = 204;
      return;
    }

    // Use the direct media URL — strapi::public middleware serves /uploads/
    const configUrl: string = strapi.config.get('server.url') || `${ctx.protocol}://${ctx.host}`;
    // Ensure HTTPS in production (Strapi behind reverse proxy may report http)
    const baseUrl = configUrl.replace(/^http:/, 'https:');
    const downloadUrl = `${baseUrl}${binary.url}`;

    ctx.body = {
      version: release.version,
      notes: release.notes || '',
      pub_date: release.publishedAt || release.updatedAt,
      url: downloadUrl,
      signature: release.signature,
    };
  },

  /**
   * GET /api/app-releases/download/:documentId
   * Stream the binary file for a specific release — used for new device installs.
   */
  async download(ctx) {
    const { documentId } = ctx.params;

    const release: any = await strapi.documents(UID).findFirst({
      filters: { documentId },
      status: 'published',
      populate: ['binary'],
    });

    if (!release) {
      ctx.notFound('Release not found');
      return;
    }

    const binary = Array.isArray(release.binary) ? release.binary[0] : release.binary;
    if (!binary) {
      ctx.notFound('Binary not found');
      return;
    }

    // Stream the file from the uploads directory
    const uploadsDir = path.resolve(strapi.dirs.static.public, 'uploads');
    const filePath = path.join(uploadsDir, path.basename(binary.url));

    ctx.set('Content-Type', binary.mime || 'application/octet-stream');
    ctx.set('Content-Disposition', `attachment; filename="${binary.name}"`);
    if (binary.size) ctx.set('Content-Length', String(binary.size));

    ctx.body = createReadStream(filePath);
  },

  /**
   * GET /api/app-releases/latest
   * Returns download info for all platforms (for a "downloads" page).
   */
  async latest(ctx) {
    const releases: any[] = await strapi.documents(UID).findMany({
      filters: { isCurrent: true },
      status: 'published',
      populate: ['binary'],
    });

    const rawUrl: string = strapi.config.get('server.url') || `${ctx.protocol}://${ctx.host}`;
    const baseUrl = rawUrl.replace(/^http:/, 'https:');

    ctx.body = releases.map((r) => {
      const binary = Array.isArray(r.binary) ? r.binary[0] : r.binary;
      return {
        version: r.version,
        platform: r.platform,
        notes: r.notes,
        downloadUrl: binary ? `${baseUrl}${binary.url}` : null,
        size: binary?.size || null,
        publishedAt: r.publishedAt,
      };
    });
  },
}));
