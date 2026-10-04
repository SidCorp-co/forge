import {
  type ContentLanguageView,
  type ContentLanguageWrite,
  contentLanguageViewOf,
} from '@forge/contracts/content-language';
import type { ApiRefusal } from './documents.js';
import type { ProjectDocument } from './schema.js';
import {
  readProjectConfig,
  readProjectDocument,
  type WriteOutcome,
  writeProjectConfig,
} from './service.js';

/** The project's setting at the document revision read; a project with no document writes `en`. */
export async function readContentLanguage(projectId: string): Promise<ContentLanguageView> {
  return contentLanguageViewOf(await readProjectDocument(projectId));
}

/** One field pair of the project document, written whole at the revision read, so the document's own checks and compare-and-set decide it. */
export async function writeContentLanguage(input: {
  projectId: string;
  userId: string;
  write: ContentLanguageWrite;
}): Promise<WriteOutcome<ProjectDocument>> {
  const { projectId, userId, write } = input;
  const held = await readProjectConfig(projectId);
  if (!held) {
    const refusal: ApiRefusal = {
      code: 'STALE_BASE',
      path: '/baseRevision',
      detail: `project ${projectId} has no project document, so it holds no content language; declare the document first (PUT /api/projects/${projectId}/config), then send the revision it answers with.`,
    };
    return { ok: false, refusals: [refusal] };
  }
  const document: Record<string, unknown> = {
    ...held.document,
    contentLanguage: write.contentLanguage,
  };
  if (write.keepTermsInEnglish === null) delete document.keepTermsInEnglish;
  else if (write.keepTermsInEnglish !== undefined) {
    document.keepTermsInEnglish = write.keepTermsInEnglish;
  }
  return writeProjectConfig({ projectId, userId, baseRevision: write.baseRevision, raw: document });
}
