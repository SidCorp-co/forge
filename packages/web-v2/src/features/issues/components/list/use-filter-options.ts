"use client";

import { useCopy } from "@/lib/i18n/interface-language";
import { useAuth } from "@/providers/auth-provider";
import { useProjectLabels, useProjectMembers, useProjectModules } from "../../hooks";
import type { ToolbarOption } from "../issues-toolbar";
import type { RowAssignee } from "../issue-row-actions";

/** The toolbar's people, label and module choices, and the names a row's assignee resolves through. */
export function useIssueFilterOptions(projectId: string, moduleId: string) {
  const membersQ = useProjectMembers(projectId);
  const labelsQ = useProjectLabels(projectId);
  const modulesQ = useProjectModules(projectId);

  // ISS-1137 — a writer is a named account, so every member is offered under
  // its own name and an agent is marked rather than replaced by a class label.
  // "any agent" stays as a KIND filter above them, which is a different
  // question from "which writer" and is why it is not one of the names.
  const { user } = useAuth();
  const t = useCopy();
  const creatorOptions: ToolbarOption[] = [
      { value: "", label: t("issues.filter.anyone") },
      ...(user ? [{ value: user.id, label: t("issues.filter.me") }] : []),
      { value: "agent", label: t("issues.filter.anyAgent") },
      ...(membersQ.data ?? [])
        .filter((m) => m.userId !== user?.id)
        .map((m) => ({
          value: m.userId,
          label: m.kind === "agent" ? t("issues.filter.agentMember", { name: m.displayName ?? m.email }) : (m.displayName ?? m.email),
        })),
    ];
  const assigneeOptions: ToolbarOption[] = [
      { value: "", label: t("issues.filter.anyone") },
      ...(user ? [{ value: user.id, label: t("issues.filter.me") }] : []),
      ...(membersQ.data ?? [])
        .filter((m) => m.userId !== user?.id)
        .map((m) => ({ value: m.userId, label: m.displayName ?? m.email })),
    ];

  const memberNames = new Map<string, RowAssignee>(
        (membersQ.data ?? []).map((m) => [
          m.userId,
          { label: m.displayName ?? m.email, agent: m.kind === "agent" },
        ]),
      );

  const labelOptions: ToolbarOption[] = [
      { value: "", label: t("issues.filter.any") },
      ...(labelsQ.data ?? [])
        .filter((l) => l.kind !== "module")
        .map((l) => ({ value: l.id, label: l.name })),
    ];
  const moduleOptions: ToolbarOption[] = [
      { value: "", label: t("issues.filter.any") },
      ...modulesQ.modules.map((m) => ({ value: m.id, label: m.name })),
    ];
  const activeModuleName = modulesQ.modules.find((m) => m.id === moduleId)?.name ?? null;

  return { creatorOptions, assigneeOptions, labelOptions, moduleOptions, memberNames, activeModuleName };
}
