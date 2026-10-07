"use client";

// Org members management card (ISS-468), used in Settings → Organizations and in the org home,
// bound to the active org: members, invitations, the org's projects, and (owner only)
// rename/delete the org.
import { ORG_ROLE_PERMISSIONS } from "@forge/contracts/permissions";
import { useState } from "react";
import {
  Button,
  PageSection,
  PageSectionBody,
  Field,
  Input,
  SectionTitle,
  type SelectOption,
  SlideOver,
} from "@/design";
import { ConfirmDialog } from "@/design/primitives/confirm-dialog";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { useDeleteOrg, useRenameOrg } from "../hooks";
import type { OrgListItem } from "../types";
import {
  AddMemberForm,
  InvitationList,
  MemberList,
  ProjectList,
  useFailToast,
} from "./org-member-sections";

const ORG_ROLES = ["member", "admin", "owner"] as const;

export function OrgMembersCard({ org, onDeleted }: { org: OrgListItem; onDeleted: () => void }) {
  const t = useCopy();
  const L = useLabel();
  const ORG_ROLE_OPTIONS: SelectOption[] = ORG_ROLES.map((value) => ({ value, label: L("role", value) }));
  const held = ORG_ROLE_PERMISSIONS[org.role];
  const canManage = held.includes("org.admin");
  const isOwner = held.includes("org.own");
  // Owner is only assignable by an owner — mirror this in BOTH the existing-
  // member dropdown and the add-member form so an admin never picks a role the
  // backend will 403 on.
  const roleOptions = isOwner
    ? ORG_ROLE_OPTIONS
    : ORG_ROLE_OPTIONS.filter((o) => o.value !== "owner");

  return (
    <PageSection>
      <PageSectionBody>
        <div className="mb-4 flex items-center justify-between gap-3">
          <SectionTitle className="fg-h3">{t("settings.orgs.membersOf", { org: org.name })}</SectionTitle>
          {isOwner && <OwnerActions org={org} onDeleted={onDeleted} />}
        </div>
        <MemberList org={org} canManage={canManage} roleOptions={roleOptions} />
        <ProjectList orgId={org.id} />
        {canManage && <InvitationList orgId={org.id} />}
        {canManage && <AddMemberForm orgId={org.id} roleOptions={roleOptions} />}
      </PageSectionBody>
    </PageSection>
  );
}

/** Rename and delete, each behind its own confirm surface. */
function OwnerActions({ org, onDeleted }: { org: OrgListItem; onDeleted: () => void }) {
  const renameOrg = useRenameOrg(org.id);
  const deleteOrg = useDeleteOrg();
  const { toast } = useToast();
  const fail = useFailToast();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(org.name);
  const t = useCopy();

  function confirmDelete() {
    deleteOrg.mutate(org.id, {
      onSuccess: () => {
        toast({ title: t("settings.orgs.deleted"), tone: "success" });
        setDeleteOpen(false);
        onDeleted();
      },
      onError: fail,
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
        toast({ title: t("settings.orgs.renamed"), tone: "success" });
        setRenameOpen(false);
      },
      onError: fail,
    });
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setRenameValue(org.name);
          setRenameOpen(true);
        }}
      >
        {t("integrations.edit.rename")}
      </Button>
      <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
        {t("integrations.row.delete")}
      </Button>

      <ConfirmDialog
        open={deleteOpen}
        title={t("settings.orgs.delete")}
        message={
          <>
            {t("settings.orgs.deleteLead")} <strong>{org.name}</strong>? {t("settings.orgs.deleteTail")}
          </>
        }
        confirmLabel={t("settings.orgs.delete")}
        tone="danger"
        loading={deleteOrg.isPending}
        onConfirm={confirmDelete}
        onClose={() => setDeleteOpen(false)}
      />

      <SlideOver open={renameOpen} onClose={() => setRenameOpen(false)} title={t("settings.orgs.rename")} width={420}>
        <form onSubmit={submitRename} className="flex h-full flex-col gap-4">
          <Field label={t("settings.orgs.name")}>
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
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={renameOrg.isPending} disabled={!renameValue.trim()}>
              {t("integrations.edit.save")}
            </Button>
          </div>
        </form>
      </SlideOver>
    </span>
  );
}
