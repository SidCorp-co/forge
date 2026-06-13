"use client";

// Org members management card (ISS-468) — extracted from orgs-tab.tsx (ISS-470)
// so it can be reused both in Settings → Organizations AND in the org home,
// bound to the active org. List/add/role/remove members, list/revoke pending
// invitations, list the org's projects, and (owner only) rename/delete the org.
// Behavior is unchanged from the original Settings embedding.
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  Field,
  IconButton,
  Input,
  Select,
  type SelectOption,
  Skeleton,
  SlideOver,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
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
  useUpdateOrgMemberRole,
} from "../hooks";
import type { OrgInvitationRow, OrgListItem, OrgMemberRow, OrgRole } from "../types";
import { ConfirmDialog } from "./confirm-dialog";

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

  function confirmRemoveMember() {
    if (!memberToRemove) return;
    removeMember.mutate(memberToRemove.userId, {
      onSuccess: () => {
        toast({ title: "Member removed", tone: "success" });
        setMemberToRemove(null);
      },
      onError: (err) => {
        toast({
          title: "Request failed",
          description: formatApiError(err),
          tone: "error",
        });
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
        toast({
          title: "Request failed",
          description: formatApiError(err),
          tone: "error",
        });
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
      onError: (err) =>
        toast({
          title: "Request failed",
          description: formatApiError(err),
          tone: "error",
        }),
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
      onError: (err) =>
        toast({
          title: "Request failed",
          description: formatApiError(err),
          tone: "error",
        }),
    });
  }

  return (
    <Card>
      <CardContent>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="fg-h3">{org.name} — members</h2>
          {isOwner && (
            <span className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRenameValue(org.name);
                  setRenameOpen(true);
                }}
              >
                Rename
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setDeleteOpen(true)}
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
          <ul className="space-y-1.5">
            {(membersQ.data ?? []).map((m) => (
              <li
                key={m.userId}
                className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-fg">{m.email}</span>
                  {user?.id === m.userId && <Badge tone="accent">You</Badge>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
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
                              toast({
                                title: "Request failed",
                                description: formatApiError(err),
                                tone: "error",
                              }),
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
                      aria-label={`Remove ${m.email}`}
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

        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <h3 className="fg-label text-fg">Projects</h3>
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
            <ul className="space-y-1.5">
              {(projectsQ.data ?? []).map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
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
            <h3 className="fg-label text-fg">Pending invitations</h3>
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
              <ul className="space-y-1.5">
                {(invitationsQ.data ?? []).map((inv) => (
                  <li
                    key={inv.email}
                    className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
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
                    toast({
                      title: "Request failed",
                      description: formatApiError(err),
                      tone: "error",
                    }),
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
        title="Remove member"
        message={
          <>
            Remove <strong>{memberToRemove?.email}</strong> from {org.name}?
            They lose access to all of its projects.
          </>
        }
        confirmLabel="Remove member"
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
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={org.name}
              autoFocus
            />
          </Field>
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
