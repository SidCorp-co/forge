/**
 * A token fenced to projects, presented for a project outside its fence, is refused at the PAT door
 * by name: which token it was, which projects it reaches, and which part of the request named the
 * project it does not. Past the door every route reads a fenced-out project as one that does not
 * exist, so the caller heard `404 project not found` from every route of a project it could see in
 * the web app, with nothing saying the credential was the cause (a release job for sidcorp-mail
 * sent the box's PAT, fenced to `forge`, 2026-10-27). The refusal reads the same whether or not the
 * named project exists, so it tells a caller nothing about projects beyond its own token's reach.
 */

import { HTTPException } from 'hono/http-exception';
import type { TokenFence } from '../credentials/token-fence.js';
import { tokenNameOf } from '../credentials/token-identity.js';
import { projectNames } from './route-refs.js';

export const PAT_PROJECT_OUTSIDE_FENCE = 'PAT_PROJECT_OUTSIDE_FENCE';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The project a request names, and where: its path, its `projectId` query, or its slug header. */
export interface NamedProject {
  by: 'path' | 'query' | 'header';
  ref: string;
}

const WHERE: Record<NamedProject['by'], string> = {
  path: 'the path',
  query: 'the projectId query parameter',
  header: 'the X-Forge-Project-Slug header',
};

/**
 * The project a request names, read after `route-refs.ts` turned a slug in the path or query into
 * its id: `/api/projects/<id>/…` first, then `?projectId=<id>`, then the slug header a project's
 * CLI sends on every call. Null where it names none.
 */
export function projectNamedBy(
  path: string,
  queryProjectId: string | undefined,
  slugHeader: string | undefined,
): NamedProject | null {
  const segments = path.split('/');
  const head = segments[3];
  if (segments[1] === 'api' && segments[2] === 'projects' && head && UUID.test(head)) {
    return { by: 'path', ref: head.toLowerCase() };
  }
  if (queryProjectId && UUID.test(queryProjectId)) {
    return { by: 'query', ref: queryProjectId.toLowerCase() };
  }
  const slug = slugHeader?.trim();
  return slug ? { by: 'header', ref: slug } : null;
}

// What a fenced project builds against, read-only (FB-320): a provider's contract versions, which the
// route answers only where a project of the fence consumes that contract
// (`ecosystem/contract/party-read.ts:contractReader`). Every other route of the provider stays fenced.
const PROVIDER_CONTRACT_READ =
  /^\/api\/projects\/[0-9a-f-]{36}\/contracts\/[^/]+\/versions(?:\/[^/]+)?\/?$/i;

/** Whether a request on a fenced token reads a provider's contract versions. */
export const readsProviderContract = (method: string, path: string): boolean =>
  (method === 'GET' || method === 'HEAD') && PROVIDER_CONTRACT_READ.test(path);

/** Refuse a request on a fenced token that names a project outside the fence; an unfenced token, or a request naming no project, passes. */
export async function refuseOutsideFence(args: {
  tokenId: string;
  fence: TokenFence;
  named: NamedProject | null;
  method: string;
  path: string;
}): Promise<void> {
  const { tokenId, fence, named } = args;
  if (fence === null || named === null) return;
  if (named.by === 'path' && readsProviderContract(args.method, args.path)) return;
  const reach = new Set(fence.map((id) => id.toLowerCase()));
  const id = named.by === 'header' ? await projectNames().projectIdOfSlug(named.ref) : named.ref;
  if (id !== null && reach.has(id.toLowerCase())) return;

  const [name, slugs] = await Promise.all([
    tokenNameOf(tokenId),
    projectNames().projectSlugsOf(fence),
  ]);
  const reaches = fence.map((projectId) => ({ id: projectId, slug: slugs.get(projectId) ?? null }));
  const reachSaid =
    reaches.length === 0
      ? 'no project at all'
      : reaches.map((p) => (p.slug ? `${p.slug} (${p.id})` : p.id)).join(', ');
  const token = name ? `"${name}" (${tokenId})` : tokenId;
  throw new HTTPException(403, {
    message:
      `${PAT_PROJECT_OUTSIDE_FENCE}: this request came on token ${token}, which reaches ${reachSaid}; ` +
      `${WHERE[named.by]} names project ${named.ref}, which it does not reach, so nothing on that ` +
      'project is answered to it. Call that project with a credential minted for it: a pane a ' +
      "runner box starts for a project carries its checkout's credential under $FORGE_BORROW_FROM, " +
      'and a person mints one under Settings → API Tokens naming the project.',
    cause: {
      code: PAT_PROJECT_OUTSIDE_FENCE,
      details: { token: { id: tokenId, name }, named, reaches },
    },
  });
}
