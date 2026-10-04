/**
 * The content language write: one field pair of the project document, written whole at the
 * revision the caller read through `writeProjectConfig`, so the document's own checks (including
 * CONTENT_LANGUAGE_INVALID) and its compare-and-set decide it. REST and MCP both call this.
 */

import type { ContentLanguageWrite } from '@forge/contracts/content-language';
import type { ApiRefusal, ProjectDocument } from '../project-config/index.js';
import {
  readProjectConfig,
  type WriteOutcome,
  writeProjectConfig,
} from '../project-config/index.js';

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
