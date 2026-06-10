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
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
// Settings → Organizations. List the caller's orgs (personal pinned first),
// create a team org, and manage members of the selected org. Org owner/admin
// get implicit project-admin on every project of the org; plain org members
// still need a per-project invite — mirror that in the helper copy.
import { useState } from "react";
import {
  useAddOrgMember,
  useCreateOrg,
  useOrgInvitations,
  useOrgMembers,
  useOrgProjects,
  useOrgs,
  useRemoveOrgMember,
  useRevokeOrgInvitation,
  useUpdateOrgMemberRole,
} from "../hooks";
import type { OrgListItem, OrgRole } from "../types";

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

      {selected && <OrgMembersCard org={selected} />}
    </div>
  );
}

function CreateOrgForm() {
  const create = useCreateOrg();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          { name: name.trim(), slug: slug.trim() },
          {
            onSuccess: () => {
              setName("");
              setSlug("");
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
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Inc"
          />
        </Field>
      </div>
      <div className="min-w-40">
        <Field label="Slug">
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
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

function OrgMembersCard({ org }: { org: OrgListItem }) {
  const membersQ = useOrgMembers(org.id);
  const addMember = useAddOrgMember(org.id);
  const updateRole = useUpdateOrgMemberRole(org.id);
  const removeMember = useRemoveOrgMember(org.id);
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");

  const canManage = org.role === "owner" || org.role === "admin";

  const projectsQ = useOrgProjects(org.id);
  const invitationsQ = useOrgInvitations(canManage ? org.id : undefined);
  const revokeInvitation = useRevokeOrgInvitation(org.id);

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-4">{org.name} — members</h2>
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
                <span className="min-w-0 truncate text-fg">{m.email}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {canManage ? (
                    <Select
                      options={ORG_ROLE_OPTIONS}
                      value={m.role}
                      onChange={(v) =>
                        updateRole.mutate(
                          { userId: m.userId, role: v as OrgRole },
                          {
                            onError: (err) =>
                              toast({
                                title: "Request failed",
                                description: formatApiError(err),
                                tone: "error",
                              }),
                          },
                        )
                      }
                      disabled={updateRole.isPending}
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
                      onClick={() =>
                        removeMember.mutate(m.userId, {
                          onError: (err) =>
                            toast({
                              title: "Request failed",
                              description: formatApiError(err),
                              tone: "error",
                            }),
                        })
                      }
                      disabled={removeMember.isPending}
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
                        onClick={() =>
                          revokeInvitation.mutate(inv.email, {
                            onSuccess: () =>
                              toast({
                                title: "Invitation revoked",
                                tone: "success",
                              }),
                            onError: (err) =>
                              toast({
                                title: "Request failed",
                                description: formatApiError(err),
                                tone: "error",
                              }),
                          })
                        }
                        disabled={revokeInvitation.isPending}
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
                  options={
                    org.role === "owner"
                      ? ORG_ROLE_OPTIONS
                      : ORG_ROLE_OPTIONS.filter((o) => o.value !== "owner")
                  }
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
    </Card>
  );
}
