// The project home's header: the project's mark and name, and its settings. Nothing on it is to read
// and not act on (REQ-11 BC-18, BC-19): the slug and the reader's role sit in the mark's tooltip.

import { IconButton, PageTitle, ProjectMark, Tooltip } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

const ROLE_COPY: Record<string, ProductCopyKey> = {
  admin: "common.role.admin",
  member: "common.role.member",
  viewer: "common.role.viewer",
};

export function ProjectHomeHeader({
  project,
  glyph,
  initials,
  onSettings,
}: {
  project: { name: string; slug: string; role: string };
  glyph: { tint: string; ink: string };
  initials: string;
  onSettings: () => void;
}) {
  const t = useCopy();
  const role = t(ROLE_COPY[project.role] ?? "common.role.org");
  return (
    <header className="mb-6 flex items-center gap-4" data-testid="project-home-header">
      <Tooltip label={`${project.slug} · ${role}`}>
        <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={initials} size={48} />
      </Tooltip>
      <div className="flex-1">
        <PageTitle className="fg-h2">{project.name}</PageTitle>
      </div>
      <IconButton icon="settings" aria-label={t("dash.projectSettings")} onClick={onSettings} />
    </header>
  );
}
