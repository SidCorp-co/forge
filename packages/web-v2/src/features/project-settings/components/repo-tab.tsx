"use client";

// Project settings → Repository. The branch work is cut from is the project document's
// `source.git.defaultBranch`, shown here and edited on the Configuration tab with the rest of the
// document. The checkout is each device binding's.
import { PageSection, PageSectionBody, Field, SectionTitle } from "@/design";
import type { ProjectDetail } from "@/features/projects/types";

export function RepoTab({ project }: { project: ProjectDetail }) {
  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-4">Repository</SectionTitle>
        <div className="space-y-4">
          <Field
            label="Default branch"
            hint="Where ISS-* branches are cut from: the project document's source.git.defaultBranch, edited on the Configuration tab."
          >
            <code className="fg-body">{project.baseBranch ?? "not declared"}</code>
          </Field>

          <div className="space-y-2">
            <SectionTitle className="fg-h4">Release path</SectionTitle>
            <p className="fg-caption text-subtle">
              Where work lands, the promotions it crosses and the environment production deploys
              from are the project document&apos;s, edited on the Configuration tab. The Release
              card under Pipeline shows what it declares.
            </p>
          </div>
        </div>
      </PageSectionBody>
    </PageSection>
  );
}
