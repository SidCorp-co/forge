"use client";

// Org members management card (ISS-468) — extracted from orgs-tab.tsx (ISS-470)
// so it can be reused both in Settings → Organizations AND in the org home,
// bound to the active org. List/add/role/remove members, list/revoke pending
// invitations, list the org's projects, and (owner only) rename/delete the org.
// Behavior is unchanged from the original Settings embedding.
import { useState } from "react";
import { readerName } from "@forge/contracts/person-name";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  ErrorState,
  Field,
  IconButton,
  Input,
  SectionTitle,
  Select,
  Skeleton,
  SlideOver,
  type SelectOption,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { failureToast } from "@/lib/api/failure-toast";
import { cn } from "@/lib/utils/cn";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import {
  useAddOrgMember,
  useDeleteOrg,
  useOrgInvitations,
  useOrgMembers,
  useOrgProjects,
  useRemoveOrgMember,
  useRenameOrg,
  useRevokeOrgInvitation,
  useUpdateOrgMemberLenses,
  useUpdateOrgMemberRole,
} from "../hooks";
import {
  MEMBER_LENS_OPTIONS,
  type MemberLens,
  type OrgInvitationRow,
  type OrgListItem,
  type OrgMemberRow,
  type OrgRole,
} from "../types";
import { ConfirmDialog, PanelFailure, type PanelFailureView } from "@/design/primitives/confirm-dialog";
import { orderPeople } from "@/lib/people/order-people";

/**
 * Per-member working-lens control (role-aware chat). Two toggle-chips — a
 * member can hold both, one, or none (none = default product/non-technical
 * voice). Read-only badges when the viewer can't manage. Soft: shapes only how
 * the interactive agent answers, never permissions.
 */
function LensControl({
  lenses,
  canManage,
  busy,
  onToggle,
}: {
  lenses: MemberLens[];
  canManage: boolean;
  busy: boolean;
  onToggle: (lens: MemberLens) => void;
}) {
  if (!canManage) {
    if (lenses.length === 0) return null;
    return (
      <span className="flex items-center gap-1">
        {MEMBER_LENS_OPTIONS.filter((o) => lenses.includes(o.value)).map((o) => (
          <Badge key={o.value} tone="neutral">
            {o.label}
          </Badge>
        ))}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1" title="Working lens — shapes how chat answers this member">
      {MEMBER_LENS_OPTIONS.map((o) => {
        const on = lenses.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            disabled={busy}
            aria-pressed={on}
            onClick={() => onToggle(o.value)}
            className={cn(
              "rounded-pill border px-2 py-0.5 text-11 font-medium transition-colors disabled:opacity-50",
              on
                ? "border-transparent bg-accent-tint text-accent-text"
                : "border-line text-subtle hover:bg-hover hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}

const ORG_ROLE_OPTIONS: SelectOption[] = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
  { value: "owner", label: "Owner" },
];

export function OrgMembersCard({
  org,
  onDeleted,
}: {
  org: OrgListItem;
  onDeleted: () => void;
}) {
  const membersQ = useOrgMembers(org.id);
  const addMember = useAddOrgMember(org.id);
  const updateRole = useUpdateOrgMemberRole(org.id);
  const updateLenses = useUpdateOrgMemberLenses(org.id);
  const removeMember = useRemoveOrgMember(org.id);
  const renameOrg = useRenameOrg(org.id);
  const deleteOrg = useDeleteOrg();
  const { user } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");

  const canManage = org.role === "owner" || org.role === "admin";
  const isOwner = org.role === "owner";
  // Owner is only assignable by an owner — mirror this in BOTH the existing-
  // member dropdown and the add-member form so an admin never picks a role the
  // backend will 403 on.
  const roleOptions = isOwner
    ? ORG_ROLE_OPTIONS
    : ORG_ROLE_OPTIONS.filter((o) => o.value !== "owner");

  const projectsQ = useOrgProjects(org.id);
  const invitationsQ = useOrgInvitations(canManage ? org.id : undefined);
  const revokeInvitation = useRevokeOrgInvitation(org.id);

  // Destructive actions go through a confirm step before firing.
  const [memberToRemove, setMemberToRemove] = useState<OrgMemberRow | null>(
    null,
  );
  const [inviteToRevoke, setInviteToRevoke] = useState<OrgInvitationRow | null>(
    null,
  );
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(org.name);
  // A refused delete or rename is told inside its own panel, never in a toast over it (ISS-1229 r28).
  const [deleteFailure, setDeleteFailure] = useState<PanelFailureView | null>(null);
  const [renameFailure, setRenameFailure] = useState<PanelFailureView | null>(null);

  // People lead with the reader, then by name, then the unnamed by when they joined; agents are listed
  // apart, and one serving none of the organization's projects is not listed at all (ISS-1229 r28).
  const members = membersQ.data ?? [];
  const people = orderPeople(
    members.filter((m) => m.kind !== "agent"),
    user?.id,
    (m) => ({ userId: m.userId, displayName: m.displayName, addedAt: m.createdAt }),
  );
  const agents = members
    .filter((m) => m.kind === "agent" && (m.projects ?? []).length > 0)
    .sort((a, b) => agentName(a).localeCompare(agentName(b)));
  const leaving = memberToRemove !== null && memberToRemove.userId === user?.id;

  function confirmRemoveMember() {
    if (!memberToRemove) return;
    const self = memberToRemove.userId === user?.id;
    removeMember.mutate(memberToRemove.userId, {
      onSuccess: () => {
        toast({ title: self ? `You left ${org.name}` : "Member removed", tone: "success" });
        setMemberToRemove(null);
        if (self) onDeleted();
      },
      onError: (err) => {
        toast(failureToast(err, self ? `You did not leave ${org.name}` : "The member was not removed"));
        setMemberToRemove(null);
      },
    });
  }

  function confirmRevokeInvitation() {
    if (!inviteToRevoke) return;
    revokeInvitation.mutate(inviteToRevoke.email, {
      onSuccess: () => {
        toast({ title: "Invitation revoked", tone: "success" });
        setInviteToRevoke(null);
      },
      onError: (err) => {
        toast(failureToast(err, "The invitation was not revoked"));
        setInviteToRevoke(null);
      },
    });
  }

  function confirmDeleteOrg() {
    deleteOrg.mutate(org.id, {
      onSuccess: () => {
        toast({ title: "Organization deleted", tone: "success" });
        setDeleteOpen(false);
        onDeleted();
      },
      onError: (err) => {
        const { title, description } = failureToast(err, "The organization was not deleted");
        setDeleteFailure({ title, description });
      },
    });
  }

  function submitRename(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === org.name) {
      setRenameOpen(false);
      return;
    }
    renameOrg.mutate(trimmed, {
      onSuccess: () => {
        toast({ title: "Organization renamed", tone: "success" });
        setRenameOpen(false);
      },
      onError: (err) => {
        const { title, description } = failureToast(err, "The organization was not renamed");
        setRenameFailure({ title, description });
      },
    });
  }

  return (
    <Card>
      <CardContent>
        <div className="mb-4 flex items-center justify-between gap-3">
          <SectionTitle className="fg-h3">{org.name} — members</SectionTitle>
          {isOwner && (
            <span className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRenameValue(org.name);
                  setRenameFailure(null);
                  setRenameOpen(true);
                }}
              >
                Rename
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setDeleteFailure(null);
                  setDeleteOpen(true);
                }}
              >
                Delete
              </Button>
            </span>
          )}
        </div>
        {membersQ.isLoading ? (
          <Skeleton className="h-9 w-full rounded-md" />
        ) : membersQ.isError ? (
          <ErrorState
            message={formatApiError(membersQ.error)}
            onRetry={() => membersQ.refetch()}
          />
        ) : (
          <ul className="divide-y divide-line" data-testid="org-card-rows">
            {people.map((m) => (
              <li
                key={m.userId}
                data-testid="org-member-row"
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5"
              >
                {/* The member's name first, You for the reader, the address under it (ISS-1229 r27). */}
                <span className="flex min-w-[12rem] flex-1 flex-col" data-testid="org-member-who">
                  <span className="min-w-0 truncate text-fg" data-testid="org-member-name">
                    {readerName(m.userId, user?.id, m.displayName)}
                  </span>
                  <span className="fg-body-sm min-w-0 truncate text-muted" data-testid="org-member-email">
                    {m.email}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <LensControl
                    lenses={m.lenses ?? []}
                    canManage={canManage}
                    busy={
                      updateLenses.isPending &&
                      updateLenses.variables?.userId === m.userId
                    }
                    onToggle={(lens) => {
                      const cur = m.lenses ?? [];
                      const next = cur.includes(lens)
                        ? cur.filter((l) => l !== lens)
                        : [...cur, lens];
                      updateLenses.mutate(
                        { userId: m.userId, lenses: next },
                        {
                          onError: (err) =>
                            toast(failureToast(err, "The lens was not changed")),
                        },
                      );
                    }}
                  />
                  {canManage ? (
                    <Select
                      options={roleOptions}
                      value={m.role}
                      onChange={(v) =>
                        updateRole.mutate(
                          { userId: m.userId, role: v as OrgRole },
                          {
                            onSuccess: () =>
                              toast({ title: "Role updated", tone: "success" }),
                            onError: (err) =>
                              toast(failureToast(err, "The role was not changed")),
                          },
                        )
                      }
                      disabled={
                        updateRole.isPending &&
                        updateRole.variables?.userId === m.userId
                      }
                    />
                  ) : (
                    <Badge tone={m.role === "owner" ? "accent" : "neutral"}>
                      {m.role}
                    </Badge>
                  )}
                  {canManage && (
                    <IconButton
                      icon="trash"
                      aria-label={
                        m.userId === user?.id
                          ? `Leave ${org.name}`
                          : `Remove ${readerName(m.userId, user?.id, m.displayName, "inside")}, ${m.email}`
                      }
                      onClick={() => setMemberToRemove(m)}
                      disabled={
                        removeMember.isPending &&
                        removeMember.variables === m.userId
                      }
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {agents.length > 0 && (
          <div className="mt-4 space-y-3 border-t border-line pt-4" data-testid="org-agents">
            <CardTitle className="fg-label text-fg">Agents</CardTitle>
            <ul className="divide-y divide-line" data-testid="org-card-rows">
              {agents.map((a) => (
                <li key={a.userId} data-testid="org-agent-row" className="flex flex-col py-2.5">
                  <span className="min-w-0 truncate font-mono text-fg" data-testid="org-agent-name">
                    {agentName(a)}
                  </span>
                  <span className="fg-body-sm min-w-0 text-muted" data-testid="org-agent-projects">
                    {a.projects.map((p) => p.name).join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <CardTitle className="fg-label text-fg">Projects</CardTitle>
          {projectsQ.isLoading ? (
            <Skeleton className="h-9 w-full rounded-md" />
          ) : projectsQ.isError ? (
            <ErrorState
              message={formatApiError(projectsQ.error)}
              onRetry={() => projectsQ.refetch()}
            />
          ) : (projectsQ.data ?? []).length === 0 ? (
            <p className="fg-body-sm text-subtle">No projects yet.</p>
          ) : (
            <ul className="divide-y divide-line" data-testid="org-card-rows">
              {(projectsQ.data ?? []).map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <span className="min-w-0 truncate text-fg">{p.name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {p.archivedAt && <Badge tone="amber">archived</Badge>}
                    <span className="fg-body-sm text-subtle">{p.slug}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {canManage && (
          <div className="mt-4 space-y-3 border-t border-line pt-4">
            <CardTitle className="fg-label text-fg">Pending invitations</CardTitle>
            {invitationsQ.isLoading ? (
              <Skeleton className="h-9 w-full rounded-md" />
            ) : invitationsQ.isError ? (
              <ErrorState
                message={formatApiError(invitationsQ.error)}
                onRetry={() => invitationsQ.refetch()}
              />
            ) : (invitationsQ.data ?? []).length === 0 ? (
              <p className="fg-body-sm text-subtle">No pending invitations.</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="org-card-rows">
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
                        aria-label={`Revoke invitation for ${inv.email}`}
                        onClick={() => setInviteToRevoke(inv)}
                        disabled={
                          revokeInvitation.isPending &&
                          revokeInvitation.variables === inv.email
                        }
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {canManage && (
          <form
            className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = email.trim().toLowerCase();
              addMember.mutate(
                { email: trimmed, role },
                {
                  onSuccess: (data) => {
                    setEmail("");
                    // 202 = no account yet → an email invitation was sent.
                    if ("invited" in data && data.invited) {
                      toast({
                        title: "Invitation sent",
                        description: trimmed,
                        tone: "success",
                      });
                    } else {
                      toast({ title: "Member added", tone: "success" });
                    }
                  },
                  onError: (err) =>
                    toast(failureToast(err, "The member was not added")),
                },
              );
            }}
          >
            <div className="min-w-56 flex-1">
              <Field label="Add member by email">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@example.com"
                />
              </Field>
            </div>
            <div className="min-w-32">
              <Field label="Role">
                <Select
                  options={roleOptions}
                  value={role}
                  onChange={(v) => setRole(v as OrgRole)}
                />
              </Field>
            </div>
            <Button
              type="submit"
              disabled={!email.trim() || addMember.isPending}
            >
              Add
            </Button>
          </form>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!memberToRemove}
        title={leaving ? "Leave organization" : "Remove member"}
        message={
          leaving ? (
            <>
              Leave <strong>{org.name}</strong>? You lose access to all of its projects.
            </>
          ) : (
            <>
              Remove{" "}
              <strong>
                {readerName(memberToRemove?.userId, user?.id, memberToRemove?.displayName, "inside")}
              </strong>{" "}
              ({memberToRemove?.email}) from {org.name}?
              They lose access to all of its projects.
            </>
          )
        }
        confirmLabel={leaving ? "Leave organization" : "Remove member"}
        tone="danger"
        loading={removeMember.isPending}
        onConfirm={confirmRemoveMember}
        onClose={() => setMemberToRemove(null)}
      />

      <ConfirmDialog
        open={!!inviteToRevoke}
        title="Revoke invitation"
        message={
          <>
            Revoke the pending invitation for{" "}
            <strong>{inviteToRevoke?.email}</strong>? They will no longer be able
            to join with it.
          </>
        }
        confirmLabel="Revoke invitation"
        tone="danger"
        loading={revokeInvitation.isPending}
        onConfirm={confirmRevokeInvitation}
        onClose={() => setInviteToRevoke(null)}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete organization"
        message={
          <>
            Delete <strong>{org.name}</strong>? This cannot be undone.
          </>
        }
        confirmLabel="Delete organization"
        tone="danger"
        loading={deleteOrg.isPending}
        failure={deleteFailure}
        onConfirm={confirmDeleteOrg}
        onClose={() => setDeleteOpen(false)}
      />

      <SlideOver
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename organization"
        width={420}
      >
        <form onSubmit={submitRename} className="flex h-full flex-col gap-4">
          <Field label="Organization name">
            <Input
              value={renameValue}
              onChange={(e) => {
                setRenameValue(e.target.value);
                setRenameFailure(null);
              }}
              placeholder={org.name}
              autoFocus
            />
          </Field>
          {renameFailure && <PanelFailure failure={renameFailure} />}
          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRenameOpen(false)}
              disabled={renameOrg.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={renameOrg.isPending}
              disabled={!renameValue.trim()}
            >
              Save
            </Button>
          </div>
        </form>
      </SlideOver>
    </Card>
  );
}

/** An agent is named by the address it is reached at, else by the name it was given. */
function agentName(member: OrgMemberRow): string {
  if (member.handle) return `@${member.handle}`;
  return member.displayName?.trim() || "An agent";
}
