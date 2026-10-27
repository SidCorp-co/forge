"use client";

// Project-tier release-run detail (`/projects/[slug]/releases/[runId]`).
// Resolve slug → projectId via the project console list, the same way the
// pipeline and issues pages do, then render the screen. The screen owns its own
// loading and error states, so this page is a slug adapter and nothing else.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { ProjectsUnread } from "@/features/projects/components/project-missing";
import { useProjects } from "@/features/projects/hooks";
import { ReleaseRunScreen } from "@/features/releases/components/release-run-screen";

export default function ProjectReleaseRunPage() {
	const params = useParams<{ slug: string; runId: string }>();
	const slug = params?.slug;
	const runId = params?.runId;
	const { data: projects, isLoading, isError, error } = useProjects();

	if (isLoading) {
		return (
			<div className="grid min-h-[60vh] place-items-center">
				<ProjectLoader label="loading release run…" />
			</div>
		);
	}

	if (isError) {
		return (
			<div className="grid min-h-[60vh] place-items-center">
				<ProjectsUnread error={error} />
			</div>
		);
	}

	const project = projects?.find((p) => p.slug === slug);
	if (!project || !runId) {
		return (
			<div className="grid min-h-[60vh] place-items-center">
				<ErrorState
					level={1}
					title="Release run not found"
					message="This project doesn't exist, you don't have access to it, or the run id is missing from the address."
					final
				/>
			</div>
		);
	}

	return <ReleaseRunScreen projectId={project.id} runId={runId} />;
}
