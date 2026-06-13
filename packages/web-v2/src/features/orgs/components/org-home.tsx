"use client";

// Org home (ISS-470) — the "something changed" screen for the active org. Shows
// the org name, its projects, and (for team orgs) its members, all bound to the
// active org from the chrome switcher. Members management reuses the ISS-468
// OrgMembersCard verbatim, so role-gating / add / remove / invite / rename /
// delete behave identically to Settings → Organizations. For a personal org we
// suppress the team-member panel (there is no team to manage) and show a
// projects-only view so single-org users never hit an empty dead-end.
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Icon,
  PageContainer,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useActiveOrg } from "../active-org";
import { useOrgProjects } from "../hooks";
import { OrgMembersCard } from "./org-members-card";

export function OrgHome() {
  const router = useRouter();
  const { activeOrg } = useActiveOrg();

  // null only while orgs/preferences resolve — render a light skeleton.
  if (!activeOrg) {
    return (
      <PageContainer>
        <div className="space-y-2">
          <Skeleton className="h-9 w-64 rounded-md" />
          <Skeleton className="h-40 w-full rounded-md" />
        </div>
      </PageContainer>
    );
  }

  const label = activeOrg.isPersonal ? "Personal" : activeOrg.name;

  return (
    <PageContainer>
      <header className="mb-5 flex flex-wrap items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-md border border-line bg-sunken text-subtle">
          <Icon name="users" size={18} />
        </span>
        <h1 className="fg-h2">{label}</h1>
        {activeOrg.isPersonal ? (
          <Badge tone="neutral">personal</Badge>
        ) : (
          <Badge tone={activeOrg.role === "owner" ? "accent" : "neutral"}>{activeOrg.role}</Badge>
        )}
      </header>

      {activeOrg.isPersonal ? (
        <PersonalOrgProjects orgId={activeOrg.id} />
      ) : (
        // Team org — the full members card also renders the org's project list,
        // pending invitations, and (owner) rename/delete.
        <OrgMembersCard org={activeOrg} onDeleted={() => router.push("/projects")} />
      )}
    </PageContainer>
  );
}

/** Personal workspace — projects only (no team-member management surface). */
function PersonalOrgProjects({ orgId }: { orgId: string }) {
  const projectsQ = useOrgProjects(orgId);

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Projects</h2>
        <p className="fg-body-sm mb-4 text-muted">Projects in your personal workspace.</p>
        {projectsQ.isLoading ? (
          <Skeleton className="h-9 w-full rounded-md" />
        ) : projectsQ.isError ? (
          <ErrorState message={formatApiError(projectsQ.error)} onRetry={() => projectsQ.refetch()} />
        ) : (projectsQ.data ?? []).length === 0 ? (
          <EmptyState
            title="No projects yet"
            message="Projects you create in your personal workspace will appear here."
          />
        ) : (
          <ul className="space-y-1.5">
            {(projectsQ.data ?? []).map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.slug}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 transition-colors hover:bg-hover"
                >
                  <span className="min-w-0 truncate text-fg">{p.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {p.archivedAt && <Badge tone="amber">archived</Badge>}
                    <span className="fg-body-sm text-subtle">{p.slug}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
