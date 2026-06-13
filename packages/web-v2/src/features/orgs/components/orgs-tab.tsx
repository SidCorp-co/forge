"use client";

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
import { SLUG_RE, slugify } from "@/lib/slug";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
// Settings → Organizations. List the caller's orgs (personal pinned first),
// create a team org, and manage members of the selected org. Org owner/admin
// get implicit project-admin on every project of the org; plain org members
// still need a per-project invite — mirror that in the helper copy.
import { useState } from "react";
import {
  useAddOrgMember,
  useCreateOrg,
  useDeleteOrg,
  useOrgInvitations,
  useOrgMembers,
  useOrgProjects,
  useOrgs,
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

export function OrgsTab() {
  const orgsQ = useOrgs();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (orgsQ.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-3/4 rounded-md" />
      </div>
    );
  }
  if (orgsQ.isError) {
    return (
      <ErrorState
        message={formatApiError(orgsQ.error)}
        onRetry={() => orgsQ.refetch()}
      />
    );
  }

  const orgs = [...(orgsQ.data ?? [])].sort(
    (a, b) =>
      Number(b.isPersonal) - Number(a.isPersonal) ||
      a.name.localeCompare(b.name),
  );
  const selected = orgs.find((o) => o.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">Organizations</h2>
          <p className="fg-body-sm mb-4 text-muted">
            Every project lives in exactly one org. Org owners/admins manage all
            of its projects; org members still need a per-project invite.
          </p>
          <ul className="space-y-1.5">
            {orgs.map((o) => (
              <li
                key={o.id}
                className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-fg">
                  {o.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {o.isPersonal && <Badge tone="neutral">personal</Badge>}
                  <Badge tone={o.role === "owner" ? "accent" : "neutral"}>
                    {o.role}
                  </Badge>
                  {!o.isPersonal && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setSelectedId(o.id === selectedId ? null : o.id)
                      }
                    >
                      {o.id === selectedId ? "Close" : "Members"}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <CreateOrgForm />
        </CardContent>
      </Card>

      {selected && (
        <OrgMembersCard
          org={selected}
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function CreateOrgForm() {
  const create = useCreateOrg();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugError, setSlugError] = useState<string | undefined>(undefined);

  // Mirror the name into the slug until the user takes manual control.
  const onNameChange = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };
  const onSlugChange = (value: string) => {
    setSlugEdited(true);
    setSlug(value);
    if (slugError) setSlugError(undefined);
  };

  function validateSlug(value: string): string | undefined {
    if (value.length < 3) return "Slug must be at least 3 characters.";
    if (value.length > 64) return "Slug must be 64 characters or fewer.";
    if (!SLUG_RE.test(value))
      return "Slug may use lowercase letters, digits, and hyphens only.";
    return undefined;
  }

  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmedName = name.trim();
        const trimmedSlug = slug.trim();
        const err = validateSlug(trimmedSlug);
        if (err) {
          setSlugError(err);
          return;
        }
        setSlugError(undefined);
        create.mutate(
          { name: trimmedName, slug: trimmedSlug },
          {
            onSuccess: () => {
              setName("");
              setSlug("");
              setSlugEdited(false);
              toast({ title: "Organization created", tone: "success" });
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
      <div className="min-w-48 flex-1">
        <Field label="New org name">
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Acme Inc"
          />
        </Field>
      </div>
      <div className="min-w-40">
        <Field label="Slug" error={slugError}>
          <Input
            value={slug}
            onChange={(e) => onSlugChange(e.target.value)}
            placeholder="acme-inc"
            pattern="[a-z0-9-]{3,64}"
          />
        </Field>
      </div>
      <Button
        type="submit"
        disabled={!name.trim() || !slug.trim() || create.isPending}
      >
        Create org
      </Button>
    </form>
  );
}

function OrgMembersCard({
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
