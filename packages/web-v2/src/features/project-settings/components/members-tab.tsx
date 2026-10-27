"use client";

import {
  Badge,
  Button,
  CardTitle,
  ErrorState,
  Field,
  IconButton,
  Input,
  ReadFailedLine,
  SectionTitle,
  Select,
  Skeleton,
  type SelectOption,
  SettingsSection,
} from "@/design";
import { isAgentAddress } from "@/features/auth/agent-address";
import { useOrgMembers } from "@/features/orgs/hooks";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
// Project settings → Members. List (email + role) + direct-add from the org +
// invite by email + remove + inline role change, plus a pending-invitations
// list (cancel). Invite / remove / role-change / invitation controls are
// owner-gated by core; we surface them only when the caller is the owner
// (`canEdit`). The "Add from organization" block direct-adds a same-org user
// (no email round trip) and is hidden for personal-org projects.
import { useState } from "react";
import {
  useDirectAddMember,
  useInvitations,
  useInviteMember,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
  useUpdateMemberRole,
} from "../hooks";

const ROLE_OPTIONS: SelectOption[] = [
  { value: "viewer", label: "Viewer" },
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];


/** The org members the add picker offers: not already on the project, and people only, since an
 *  agent account's projects are set on the agent and the add door refuses one (ISS-1421 r3). */
export function orgCandidatesFor<M extends { userId: string; email: string }>(
  orgMembers: readonly M[],
  memberIds: ReadonlySet<string>,
): M[] {
  return orgMembers.filter((m) => !memberIds.has(m.userId) && !isAgentAddress(m.email));
}

export function MembersTab({
  projectId,
  canEdit,
}: { projectId: string; canEdit: boolean }) {
  const membersQ = useMembers(projectId);
  const invitationsQ = useInvitations(canEdit ? projectId : undefined);
  const invite = useInviteMember(projectId);
  const remove = useRemoveMember(projectId);
  const revoke = useRevokeInvitation(projectId);
  const updateRole = useUpdateMemberRole(projectId);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  // Direct-add from the project's org (hidden for personal-org projects).
  const projectsQ = useProjectsIncludingArchived();
  const listItem = (projectsQ.data ?? []).find((p) => p.id === projectId);
  const orgId =
    listItem && !listItem.orgIsPersonal ? listItem.orgId : undefined;
  const orgMembersQ = useOrgMembers(canEdit ? orgId : undefined);
  const directAdd = useDirectAddMember(projectId);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<"admin" | "member" | "viewer">(
    "member",
  );

  const memberIds = new Set((membersQ.data ?? []).map((m) => m.userId));
  const orgCandidates = orgCandidatesFor(orgMembersQ.data ?? [], memberIds);
  const orgCandidateOptions: SelectOption[] = orgCandidates.map((m) => ({
    value: m.userId,
    label: m.email,
  }));

  function send() {
    const trimmed = email.trim();
    if (!trimmed) return;
    invite.mutate({ email: trimmed, role }, { onSuccess: () => setEmail("") });
  }

  function addFromOrg() {
    if (!addUserId) return;
    directAdd.mutate(
      { userId: addUserId, role: addRole },
      { onSuccess: () => setAddUserId("") },
    );
  }

  return (
    <SettingsSection>
      <SectionTitle className="fg-h3 mb-4">Members</SectionTitle>

      {membersQ.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-3/4 rounded-md" />
        </div>
      ) : membersQ.isError ? (
        <ErrorState title="Couldn't load members"
          message={formatApiError(membersQ.error)}
          error={membersQ.error} onRetry={() => membersQ.refetch()}
        />
      ) : (
        <ul className="divide-y divide-line">
          {(membersQ.data ?? []).map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <span className="min-w-0 truncate text-fg">{m.email}</span>
              <span className="flex shrink-0 items-center gap-2">
                {canEdit ? (
                  <Select
                    options={ROLE_OPTIONS}
                    value={m.role}
                    onChange={(v) =>
                      updateRole.mutate({
                        userId: m.userId,
                        role: v as "admin" | "member" | "viewer",
                      })
                    }
                    disabled={updateRole.isPending}
                  />
                ) : (
                  <Badge tone={m.role === "admin" ? "accent" : "neutral"}>
                    {m.role}
                  </Badge>
                )}
                {canEdit && (
                  <IconButton
                    icon="trash"
                    aria-label={`Remove ${m.email}`}
                    onClick={() => remove.mutate(m.userId)}
                    disabled={remove.isPending}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <CardTitle className="fg-label text-fg">Pending invitations</CardTitle>
          {invitationsQ.isLoading ? (
            <Skeleton className="h-9 w-full rounded-md" />
          ) : invitationsQ.isError ? (
            <ErrorState title="Couldn't load invitations"
              message={formatApiError(invitationsQ.error)}
              error={invitationsQ.error} onRetry={() => invitationsQ.refetch()}
            />
          ) : (invitationsQ.data ?? []).length === 0 ? (
            <p className="fg-body-sm text-subtle">No pending invitations.</p>
          ) : (
            <ul className="divide-y divide-line">
              {(invitationsQ.data ?? []).map((inv) => (
                <li
                  key={inv.email}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <span className="min-w-0 truncate text-fg">
                    {inv.email}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {inv.expired && <Badge tone="amber">Expired</Badge>}
                    <Badge tone="neutral">{inv.role}</Badge>
                    <IconButton
                      icon="trash"
                      aria-label={`Cancel invitation for ${inv.email}`}
                      onClick={() => revoke.mutate(inv.email)}
                      disabled={revoke.isPending}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* A read this choice stands on that failed is said where the choice would be (ISS-1229 r48). */}
      {canEdit && projectsQ.isError && !listItem && (
        <div className="mt-4 border-t border-line pt-4">
          <ReadFailedLine
            what="your projects, so this project's organization is not known"
            why={formatApiError(projectsQ.error)}
            error={projectsQ.error} onRetry={() => void projectsQ.refetch()}
          />
        </div>
      )}
      {canEdit && orgId && orgMembersQ.isError && orgMembersQ.data === undefined && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <CardTitle className="fg-label text-fg">Add from organization</CardTitle>
          <ReadFailedLine
            what="the organization's members"
            why={formatApiError(orgMembersQ.error)}
            error={orgMembersQ.error} onRetry={() => void orgMembersQ.refetch()}
          />
        </div>
      )}

      {canEdit && orgId && orgCandidates.length > 0 && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <CardTitle className="fg-label text-fg">Add from organization</CardTitle>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Org member">
                <Select
                  options={orgCandidateOptions}
                  value={addUserId}
                  onChange={(v) => setAddUserId(v)}
                  placeholder="Select an org member…"
                />
              </Field>
            </div>
            <div className="sm:w-40">
              <Field label="Role">
                <Select
                  options={ROLE_OPTIONS}
                  value={addRole}
                  onChange={(v) =>
                    setAddRole(v as "admin" | "member" | "viewer")
                  }
                />
              </Field>
            </div>
            <Button
              variant="primary"
              icon="plus"
              loading={directAdd.isPending}
              disabled={!addUserId}
              onClick={addFromOrg}
              className="min-h-11"
            >
              Add
            </Button>
          </div>
        </div>
      )}

      {canEdit && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <CardTitle className="fg-label text-fg">
            Invite by email (outside the org)
          </CardTitle>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Email">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") send();
                  }}
                />
              </Field>
            </div>
            <div className="sm:w-40">
              <Field label="Role">
                <Select
                  options={ROLE_OPTIONS}
                  value={role}
                  onChange={(v) => setRole(v as "admin" | "member")}
                />
              </Field>
            </div>
            <Button
              variant="primary"
              icon="mail"
              loading={invite.isPending}
              disabled={email.trim() === ""}
              onClick={send}
              className="min-h-11"
            >
              Invite
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
