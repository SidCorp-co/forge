"use client";

import { PageSection, PageSectionBody, SectionTitle } from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import {
	BindingsSection,
	PolicyDocumentSection,
	ProjectDocumentSection,
	TestingProfilesSection,
} from "./config-documents";
import { EffectiveSection, EnvironmentStateSection } from "./config-readings";
import { SecretsSection } from "./secrets-section";

export function ConfigTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
	return (
		<PageSection>
			<PageSectionBody>
				<SectionTitle className="fg-h3 mb-1">Configuration</SectionTitle>
				<p className="fg-body-sm text-muted">
					Each document is saved whole against the revision it was read at. One that moved since is refused, and you
					choose whether to re-apply your edits or reload.
				</p>
				<ProjectDocumentSection project={project} canEdit={canEdit} />
				<EnvironmentStateSection projectId={project.id} />
				<PolicyDocumentSection projectId={project.id} canEdit={canEdit} />
				<TestingProfilesSection projectId={project.id} canEdit={canEdit} />
				<SecretsSection projectId={project.id} canEdit={canEdit} />
				<BindingsSection projectId={project.id} canEdit={canEdit} />
				<EffectiveSection projectId={project.id} />
			</PageSectionBody>
		</PageSection>
	);
}
