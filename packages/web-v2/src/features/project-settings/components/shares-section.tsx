
// Project settings → People → Share links. Who can read this project's answers is the People
// section's question, and a share link is the one way an answer reaches someone the members list
// does not name, so the project's links are listed and revoked here, under its members.

import { PageSection, PageSectionBody, SectionTitle } from "@/design";
import { ShareList } from "@/features/shares";
import { useCopy } from "@/lib/i18n/interface-language";
import { useMembers } from "../hooks";

export function ShareSettings({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
	const t = useCopy();
	const membersQ = useMembers(projectId);
	const nameOf = (userId: string) => {
		const m = membersQ.data?.find((row) => row.userId === userId);
		return m ? (m.displayName ?? m.email) : null;
	};
	return (
		<PageSection>
			<PageSectionBody>
				<SectionTitle className="fg-h3 mb-4 text-accent-text!">{t("settings.project.people.shareLinks")}</SectionTitle>
				<ShareList projectId={projectId} nameOf={nameOf} isAdmin={isAdmin} />
			</PageSectionBody>
		</PageSection>
	);
}
