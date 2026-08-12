import type { ProjectListItem } from "@/features/projects/types";

export function canManageUxContract(
	project: Pick<ProjectListItem, "role" | "orgRole">,
) {
	return project.role === "admin";
}
