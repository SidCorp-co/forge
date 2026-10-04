import { type ContentLanguageView, contentLanguageViewOf } from '@forge/contracts/content-language';
import { readProjectDocument } from '../project-config/service.js';

/** The project's setting at the document revision read; a project with no document writes `en`. */
export async function readContentLanguage(projectId: string): Promise<ContentLanguageView> {
  return contentLanguageViewOf(await readProjectDocument(projectId));
}
