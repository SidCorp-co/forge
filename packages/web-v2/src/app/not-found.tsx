"use client";

import { usePathname } from "next/navigation";
import { usePreferences } from "@/features/preferences/hooks";
import { useProjects } from "@/features/projects/hooks";
import { NotFoundBody } from "@/features/shell/components/not-found-body";
import { projectSlugOf } from "@/features/shell/project-slug";
import { useContentLanguage } from "@/lib/api/content-language";
import { InterfaceLanguageScope, resolveInterfaceLanguage } from "@/lib/i18n/interface-language";

/**
 * Global 404. Renders OUTSIDE the (workspace) shell, so it is fully
 * self-contained (own centering + app background) and reads the person's own
 * interface language, else, under a project's URL, that project's content language
 * as the workspace would: a vi project's stale link reads its 404 in vi.
 * `next/link` auto-prefixes the basePath; web-v2 serves at root (ISS-397) so Home resolves to `/`.
 */
export default function NotFound() {
  const slug = projectSlugOf(usePathname());
  const project = useProjects().data?.find((p) => p.slug === slug);
  const content = useContentLanguage(project?.id).data?.contentLanguage;
  const language = resolveInterfaceLanguage(usePreferences().data?.language, content);
  return (
    <InterfaceLanguageScope language={language}>
      <NotFoundBody />
    </InterfaceLanguageScope>
  );
}
