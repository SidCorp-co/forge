import { withArticle } from '@forge/contracts/articles';
import { hostOf } from '@forge/contracts/git-repository';
import type { ConfigRefusal } from './rules.js';
import type { ProjectDocument } from './schema.js';

const PATH = '/release/changeRequests';

/**
 * REQ-63 BC-1: a release that merges change requests answers to an approval, ships to no
 * environment, and needs a repository a host serves. Each missing fact is refused by name, so the
 * key is never accepted where it would do nothing (`release.approval.required` alone on a project
 * with no production environment is exactly that silence).
 */
export function checkChangeRequestRelease(doc: ProjectDocument): ConfigRefusal[] {
  if (doc.release?.changeRequests !== true) return [];
  const out: ConfigRefusal[] = [];
  const unsupported = (detail: string) =>
    out.push({ code: 'CHANGE_REQUEST_RELEASE_UNSUPPORTED', path: PATH, detail });
  if (doc.release.approval.required !== true) {
    unsupported(
      'a release that merges change requests waits for its approval before the first merge, so it needs `release.approval.required: true`',
    );
  }
  const production = Object.entries(doc.environments).find(([, e]) => e.tier === 'production');
  if (production) {
    unsupported(
      `environment "${production[0]}" is production, and a release that merges change requests deploys nothing: remove \`release.changeRequests\` to release by deploying, or declare no production environment`,
    );
  }
  if (doc.source.type !== 'git' || hostOf(doc.source.git.repository) === null) {
    unsupported(
      doc.source.type !== 'git'
        ? `the source is ${withArticle(doc.source.type)} source, and only a git repository a host serves takes change requests`
        : `the repository "${doc.source.git.repository}" is a local path, which no host serves, so there is no change request to merge: declare the hosted repository (host.tld/owner/repo) first`,
    );
  }
  return out;
}
