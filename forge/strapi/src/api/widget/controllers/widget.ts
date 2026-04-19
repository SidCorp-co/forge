import { resolve } from 'path';
import { readFile, stat } from 'fs/promises';

let cachedBundle: string | null = null;
let cachedHash: string | null = null;
let cachedMtime: number | null = null;

async function loadBundle(): Promise<{ bundle: string; hash: string }> {
  const bundlePath = resolve(process.cwd(), 'public/forge-widget.js');
  // Check file mtime to bust cache on redeploy
  const st = await stat(bundlePath);
  const mtime = st.mtimeMs;
  if (cachedBundle && cachedHash && cachedMtime === mtime) {
    return { bundle: cachedBundle, hash: cachedHash };
  }
  cachedBundle = await readFile(bundlePath, 'utf-8');
  cachedMtime = mtime;
  // Simple hash for ETag
  let h = 0;
  for (let i = 0; i < cachedBundle.length; i++) h = ((h << 5) - h + cachedBundle.charCodeAt(i)) | 0;
  cachedHash = Math.abs(h).toString(36);
  return { bundle: cachedBundle, hash: cachedHash };
}

export default {
  async serve(ctx) {
    const { slug } = ctx.params;

    const projects = await strapi.documents('api::project.project').findMany({
      filters: { slug: { $eq: slug } },
      limit: 1,
    });
    const project = projects[0] as any;
    if (!project) return ctx.notFound('Project not found');

    let bundle: string;
    let hash: string;
    try {
      const result = await loadBundle();
      bundle = result.bundle;
      hash = result.hash;
    } catch {
      return ctx.notFound('Widget bundle not found. Run: cd forge/web && npm run build:widget');
    }

    // Inject auto-init with project's API key at the end of the bundle
    const apiUrl = `${ctx.protocol}://${ctx.host}`;
    const initScript = `\n;ForgeWidget.init(${JSON.stringify({
      apiKey: project.apiKey,
      apiUrl,
    })});`;

    ctx.type = 'application/javascript';
    ctx.set('Cache-Control', 'no-cache');
    ctx.set('ETag', `"${hash}"`);
    ctx.body = bundle + initScript;
  },
};
