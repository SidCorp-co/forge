"use client";

// Project settings → People → Share links. Who can read this project's answers is the People
// section's question, and a share link is the one way an answer reaches someone the members list
// does not name, so the project's links are listed and revoked here, under its members.

import { PageSection, PageSectionBody, SectionTitle } from "@/design";
import { ShareList } from "@/features/shares";
import { useMembers } from "../hooks";

export function SharesSection({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
	const membersQ = useMembers(projectId);
	const nameOf = (userId: string) => {
		const m = membersQ.data?.find((row) => row.userId === userId);
		return m ? (m.displayName ?? m.email) : null;
	};
	return (
		<PageSection>
			<PageSectionBody>
				<SectionTitle className="fg-h3 mb-1 text-accent-text!">Share links</SectionTitle>
				<p className="fg-body-sm mb-4 max-w-[68ch] text-muted">
					Each link opens one frozen answer, read-only, until it expires or is revoked. A link also stops
					working once the person who made it leaves the project. Its creator or a project admin can revoke it.
				</p>
				<ShareList projectId={projectId} nameOf={nameOf} isAdmin={isAdmin} />
			</PageSectionBody>
		</PageSection>
	);
}
