"use client";

import { useAuth } from "@/providers/auth-provider";
import { useMemo } from "react";
import { ANY_AGENT_LABEL } from "../../derive";
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
  const creatorOptions = useMemo<ToolbarOption[]>(
    () => [
      { value: "", label: "Anyone" },
      ...(user ? [{ value: user.id, label: "Me" }] : []),
      { value: "agent", label: ANY_AGENT_LABEL },
      ...(membersQ.data ?? [])
        .filter((m) => m.userId !== user?.id)
        .map((m) => ({
          value: m.userId,
          label: m.kind === "agent" ? `${m.displayName ?? m.email} (agent)` : (m.displayName ?? m.email),
        })),
    ],
    [membersQ.data, user],
  );
  const assigneeOptions = useMemo<ToolbarOption[]>(
    () => [
      { value: "", label: "Anyone" },
      ...(user ? [{ value: user.id, label: "Me" }] : []),
      ...(membersQ.data ?? [])
        .filter((m) => m.userId !== user?.id)
        .map((m) => ({ value: m.userId, label: m.displayName ?? m.email })),
    ],
    [membersQ.data, user],
  );

  const memberNames = useMemo(
    () =>
      new Map<string, RowAssignee>(
        (membersQ.data ?? []).map((m) => [
          m.userId,
          { label: m.displayName ?? m.email, agent: m.kind === "agent" },
        ]),
      ),
    [membersQ.data],
  );

  const labelOptions = useMemo<ToolbarOption[]>(
    () => [
      { value: "", label: "Any" },
      ...(labelsQ.data ?? [])
        .filter((l) => l.kind !== "module")
        .map((l) => ({ value: l.id, label: l.name })),
    ],
    [labelsQ.data],
  );
  const moduleOptions = useMemo<ToolbarOption[]>(
    () => [
      { value: "", label: "Any" },
      ...modulesQ.modules.map((m) => ({ value: m.id, label: m.name })),
    ],
    [modulesQ.modules],
  );
  const activeModuleName = useMemo(
    () => modulesQ.modules.find((m) => m.id === moduleId)?.name ?? null,
    [modulesQ.modules, moduleId],
  );

  return { creatorOptions, assigneeOptions, labelOptions, moduleOptions, memberNames, activeModuleName };
}
