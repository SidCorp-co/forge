"use client";

// The sections of the org members card: members (lens, role, remove), the org's projects, pending
// invitations (revoke) and the add-member form.
import { type ReactNode, useState } from "react";
import {
  Badge,
  Button,
  PageSectionTitle,
  EnumBadge,
  ErrorState,
  Field,
  IconButton,
  Input,
  Select,
  type SelectOption,
  Skeleton,
} from "@/design";
import { ConfirmDialog } from "@/design/primitives/confirm-dialog";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { useCopy } from "@/lib/i18n/interface-language";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import {
  useAddOrgMember,
  useOrgInvitations,
  useOrgMembers,
  useOrgProjects,
  useRemoveOrgMember,
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

/** The error toast every org write raises on failure. */
export function useFailToast(title?: string) {
  const { toast } = useToast();
  const t = useCopy();
  return (err: unknown) => toast({ title: title ?? t("settings.requestFailed"), description: formatApiError(err), tone: "error" });
}

const ROW = "flex items-center justify-between gap-3 py-2";

/** A query's rows as a bordered list, with its loading, error and empty states. */
function RowList<T>({
  query,
  empty,
  row,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; data?: T[]; refetch: () => unknown };
  empty?: string;
  row: (item: T) => ReactNode;
}) {
  if (query.isLoading) return <Skeleton className="h-9 w-full rounded-md" />;
  if (query.isError)
    return <ErrorState message={formatApiError(query.error)} onRetry={() => query.refetch()} />;
  const items = query.data ?? [];
  if (empty && items.length === 0) return <p className="fg-body-sm text-subtle">{empty}</p>;
  return <ul className="divide-y divide-line-subtle">{items.map(row)}</ul>;
}

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
  const t = useCopy();
  if (!canManage) {
    if (lenses.length === 0) return null;
    return (
      <span className="flex items-center gap-1">
        {MEMBER_LENS_OPTIONS.filter((o) => lenses.includes(o.value)).map((o) => (
          <Badge key={o.value} tone="neutral">
            {t(o.label)}
          </Badge>
        ))}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1" title={t("settings.orgs.lensTitle")}>
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
            {t(o.label)}
          </button>
        );
      })}
    </span>
  );
}

export function MemberList({
  org,
  canManage,
  roleOptions,
}: {
  org: OrgListItem;
  canManage: boolean;
  roleOptions: SelectOption[];
}) {
  const membersQ = useOrgMembers(org.id);
  const updateRole = useUpdateOrgMemberRole(org.id);
  const updateLenses = useUpdateOrgMemberLenses(org.id);
  const removeMember = useRemoveOrgMember(org.id);
  const { user } = useAuth();
  const { toast } = useToast();
  const t = useCopy();
  const fail = useFailToast();
  const failLens = useFailToast(t("settings.orgs.lensFailed"));
  const [memberToRemove, setMemberToRemove] = useState<OrgMemberRow | null>(null);

  function toggleLens(m: OrgMemberRow, lens: MemberLens) {
    const cur = m.lenses ?? [];
    const next = cur.includes(lens) ? cur.filter((l) => l !== lens) : [...cur, lens];
    updateLenses.mutate({ userId: m.userId, lenses: next }, { onError: failLens });
  }

  function confirmRemove() {
    if (!memberToRemove) return;
    removeMember.mutate(memberToRemove.userId, {
      onSuccess: () => toast({ title: t("settings.orgs.memberRemoved"), tone: "success" }),
      onError: fail,
      onSettled: () => setMemberToRemove(null),
    });
  }

  return (
    <>
      <RowList
        query={membersQ}
        row={(m) => (
          <li key={m.userId} className={ROW}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-fg">{m.email}</span>
              {user?.id === m.userId && <Badge tone="accent">{t("common.nav.you")}</Badge>}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <LensControl
                lenses={m.lenses ?? []}
                canManage={canManage}
                busy={updateLenses.isPending && updateLenses.variables?.userId === m.userId}
                onToggle={(lens) => toggleLens(m, lens)}
              />
              {canManage ? (
                <Select
                  options={roleOptions}
                  value={m.role}
                  onChange={(v) =>
                    updateRole.mutate(
                      { userId: m.userId, role: v as OrgRole },
                      { onSuccess: () => toast({ title: t("settings.orgs.roleUpdated"), tone: "success" }), onError: fail },
                    )
                  }
                  disabled={updateRole.isPending && updateRole.variables?.userId === m.userId}
                />
              ) : (
                <EnumBadge family="role" value={m.role} />
              )}
              {canManage && (
                <IconButton
                  icon="trash"
                  aria-label={t("settings.orgs.removeNamed", { email: m.email })}
                  onClick={() => setMemberToRemove(m)}
                  disabled={removeMember.isPending && removeMember.variables === m.userId}
                />
              )}
            </span>
          </li>
        )}
      />
      <ConfirmDialog
        open={!!memberToRemove}
        title={t("settings.orgs.removeMember")}
        message={
          <>
            {t("settings.orgs.removeLead")} <strong>{memberToRemove?.email}</strong>{" "}
            {t("settings.orgs.removeTail", { org: org.name })}
          </>
        }
        confirmLabel={t("settings.orgs.removeMember")}
        tone="danger"
        loading={removeMember.isPending}
        onConfirm={confirmRemove}
        onClose={() => setMemberToRemove(null)}
      />
    </>
  );
}

export function ProjectList({ orgId }: { orgId: string }) {
  const projectsQ = useOrgProjects(orgId);
  const t = useCopy();
  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <PageSectionTitle className="fg-label text-fg">{t("settings.orgs.projects")}</PageSectionTitle>
      <RowList
        query={projectsQ}
        empty={t("settings.orgs.noProjects")}
        row={(p) => (
          <li key={p.id} className={ROW}>
            <span className="min-w-0 truncate text-fg">{p.name}</span>
            <span className="flex shrink-0 items-center gap-2">
              {p.archivedAt && <Badge tone="amber">{t("integrations.edit.archived")}</Badge>}
              <span className="fg-body-sm text-subtle">{p.slug}</span>
            </span>
          </li>
        )}
      />
    </div>
  );
}

export function InvitationList({ orgId }: { orgId: string }) {
  const invitationsQ = useOrgInvitations(orgId);
  const revokeInvitation = useRevokeOrgInvitation(orgId);
  const { toast } = useToast();
  const fail = useFailToast();
  const [inviteToRevoke, setInviteToRevoke] = useState<OrgInvitationRow | null>(null);
  const t = useCopy();

  function confirmRevoke() {
    if (!inviteToRevoke) return;
    revokeInvitation.mutate(inviteToRevoke.email, {
      onSuccess: () => toast({ title: t("settings.orgs.invitationRevoked"), tone: "success" }),
      onError: fail,
      onSettled: () => setInviteToRevoke(null),
    });
  }

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <PageSectionTitle className="fg-label text-fg">{t("settings.orgs.pending")}</PageSectionTitle>
      <RowList
        query={invitationsQ}
        empty={t("settings.orgs.noPending")}
        row={(inv) => (
          <li key={inv.email} className={ROW}>
            <span className="min-w-0 truncate text-fg">{inv.email}</span>
            <span className="flex shrink-0 items-center gap-2">
              {inv.expired && <Badge tone="amber">{t("settings.orgs.expired")}</Badge>}
              <EnumBadge family="role" value={inv.role} />
              <IconButton
                icon="trash"
                aria-label={t("settings.orgs.revokeFor", { email: inv.email })}
                onClick={() => setInviteToRevoke(inv)}
                disabled={revokeInvitation.isPending && revokeInvitation.variables === inv.email}
              />
            </span>
          </li>
        )}
      />
      <ConfirmDialog
        open={!!inviteToRevoke}
        title={t("settings.orgs.revoke")}
        message={
          <>
            {t("settings.orgs.revokeLead")} <strong>{inviteToRevoke?.email}</strong>? {t("settings.orgs.revokeTail")}
          </>
        }
        confirmLabel={t("settings.orgs.revoke")}
        tone="danger"
        loading={revokeInvitation.isPending}
        onConfirm={confirmRevoke}
        onClose={() => setInviteToRevoke(null)}
      />
    </div>
  );
}

export function AddMemberForm({ orgId, roleOptions }: { orgId: string; roleOptions: SelectOption[] }) {
  const addMember = useAddOrgMember(orgId);
  const { toast } = useToast();
  const fail = useFailToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const t = useCopy();

  return (
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
                toast({ title: t("settings.orgs.invitationSent"), description: trimmed, tone: "success" });
              } else {
                toast({ title: t("settings.orgs.memberAdded"), tone: "success" });
              }
            },
            onError: fail,
          },
        );
      }}
    >
      <div className="min-w-56 flex-1">
        <Field label={t("settings.orgs.addByEmail")}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
          />
        </Field>
      </div>
      <div className="min-w-32">
        <Field label={t("settings.orgs.role")}>
          <Select options={roleOptions} value={role} onChange={(v) => setRole(v as OrgRole)} />
        </Field>
      </div>
      <Button type="submit" disabled={!email.trim() || addMember.isPending}>
        {t("settings.orgs.add")}
      </Button>
    </form>
  );
}
