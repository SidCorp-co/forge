"use client";

import { PageSection, PageSectionBody, SectionTitle } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { inlineRich } from "./inline-code";
import { PluginsSection } from "./plugins-section";
import { ReleaseSection } from "./release-section";

export function PipelineTab({ projectId, canEdit, slug }: { projectId: string; canEdit: boolean; slug: string }) {
  const t = useCopy();
  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-1">{t("skills.pipeline.title")}</SectionTitle>
        <p className="fg-body-sm mb-1 text-muted">
          {inlineRich(t("skills.pipeline.intro"))}
        </p>

        <ReleaseSection projectId={projectId} slug={slug} />

        <PluginsSection projectId={projectId} canEdit={canEdit} />
      </PageSectionBody>
    </PageSection>
  );
}
