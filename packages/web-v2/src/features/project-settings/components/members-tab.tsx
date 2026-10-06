"use client";

// Project settings → Members. List (email + role) + direct-add from the org +
// invite by email + remove + inline role change, plus a pending-invitations
// list (cancel). Invite / remove / role-change / invitation controls are
// owner-gated by core; we surface them only when the caller is the owner
// (`canEdit`). The "Add from organization" block direct-adds a same-org user
// (no email round trip) and is hidden for personal-org projects.
import { type ReactNode, useState } from "react";
import {
  Badge,
  Button,
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  EnumBadge,
  ErrorState,
  Field,
  IconButton,
  Input,
  SectionTitle,
  Select,
  type SelectOption,
  Skeleton,
} from "@/design";
import { useOrgMembers } from "@/features/orgs/hooks";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import {
  useDirectAddMember,
  useInvitations,
  useInviteMember,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
  useUpdateMemberRole,
} from "../hooks";
import type { ProjectRole } from "../types";

const ROLE_OPTIONS: SelectOption[] = [
  { value: "viewer", label: "Viewer" },
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

const ROW = "flex items-center justify-between gap-3 py-2";

export function MembersTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const membersQ = useMembers(projectId);
  const remove = useRemoveMember(projectId);
  const updateRole = useUpdateMemberRole(projectId);
  // Direct-add from the project's org (hidden for personal-org projects).
  const listItem = (useProjectsIncludingArchived().data ?? []).find((p) => p.id === projectId);
  const orgId = listItem && !listItem.orgIsPersonal ? listItem.orgId : undefined;

  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-4">Members</SectionTitle>
        {membersQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-3/4 rounded-md" />
          </div>
        ) : membersQ.isError ? (
          <ErrorState message={formatApiError(membersQ.error)} onRetry={() => membersQ.refetch()} />
        ) : (
          <ul className="divide-y divide-line-subtle">
            {(membersQ.data ?? []).map((m) => (
              <li key={m.userId} className={ROW}>
                <span className="min-w-0 truncate text-fg">{m.email}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {canEdit ? (
                    <Select
                      options={ROLE_OPTIONS}
                      value={m.role}
                      onChange={(v) => updateRole.mutate({ userId: m.userId, role: v as ProjectRole })}
                      disabled={updateRole.isPending}
                    />
                  ) : (
                    <EnumBadge family="role" value={m.role} />
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
          <>
            <PendingInvitations projectId={projectId} />
            {orgId && <AddFromOrg projectId={projectId} orgId={orgId} memberIds={(membersQ.data ?? []).map((m) => m.userId)} />}
            <InviteByEmail projectId={projectId} />
          </>
        )}
      </PageSectionBody>
    </PageSection>
  );
}

function Subsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <PageSectionTitle className="fg-label text-fg">{title}</PageSectionTitle>
      {children}
    </div>
  );
}

function PendingInvitations({ projectId }: { projectId: string }) {
  const invitationsQ = useInvitations(projectId);
  const revoke = useRevokeInvitation(projectId);
  const invitations = invitationsQ.data ?? [];
  return (
    <Subsection title="Pending invitations">
      {invitationsQ.isLoading ? (
        <Skeleton className="h-9 w-full rounded-md" />
      ) : invitationsQ.isError ? (
        <ErrorState message={formatApiError(invitationsQ.error)} onRetry={() => invitationsQ.refetch()} />
      ) : invitations.length === 0 ? (
        <p className="fg-body-sm text-subtle">No pending invitations.</p>
      ) : (
        <ul className="divide-y divide-line-subtle">
          {invitations.map((inv) => (
            <li key={inv.email} className={ROW}>
              <span className="min-w-0 truncate text-fg">{inv.email}</span>
              <span className="flex shrink-0 items-center gap-2">
                {inv.expired && <Badge tone="amber">Expired</Badge>}
                <EnumBadge family="role" value={inv.role} />
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
    </Subsection>
  );
}

/** The two add forms share one shape: who, at which role, and the button that sends it. */
function AddRow({ who, role, onRole, action }: { who: ReactNode; role: ProjectRole; onRole: (r: ProjectRole) => void; action: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="flex-1">{who}</div>
      <div className="sm:w-40">
        <Field label="Role">
          <Select options={ROLE_OPTIONS} value={role} onChange={(v) => onRole(v as ProjectRole)} />
        </Field>
      </div>
      {action}
    </div>
  );
}

function AddFromOrg({ projectId, orgId, memberIds }: { projectId: string; orgId: string; memberIds: string[] }) {
  const orgMembersQ = useOrgMembers(orgId);
  const directAdd = useDirectAddMember(projectId);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<ProjectRole>("member");
  const candidates = (orgMembersQ.data ?? []).filter((m) => !memberIds.includes(m.userId));
  if (candidates.length === 0) return null;
  return (
    <Subsection title="Add from organization">
      <AddRow
        who={
          <Field label="Org member">
            <Select
              options={candidates.map((m) => ({ value: m.userId, label: m.email }))}
              value={userId}
              onChange={setUserId}
              placeholder="Select an org member…"
            />
          </Field>
        }
        role={role}
        onRole={setRole}
        action={
          <Button
            variant="primary"
            icon="plus"
            loading={directAdd.isPending}
            disabled={!userId}
            onClick={() => directAdd.mutate({ userId, role }, { onSuccess: () => setUserId("") })}
            className="min-h-11"
          >
            Add
          </Button>
        }
      />
    </Subsection>
  );
}

function InviteByEmail({ projectId }: { projectId: string }) {
  const invite = useInviteMember(projectId);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("member");
  function send() {
    const trimmed = email.trim();
    if (trimmed) invite.mutate({ email: trimmed, role }, { onSuccess: () => setEmail("") });
  }
  return (
    <Subsection title="Invite by email (outside the org)">
      <AddRow
        who={
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
        }
        role={role}
        onRole={setRole}
        action={
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
        }
      />
    </Subsection>
  );
}
