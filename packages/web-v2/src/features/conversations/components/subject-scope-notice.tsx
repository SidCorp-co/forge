"use client";

// A room scoped to one record or to the onboarding answers through an agent that cannot read the
// project, and the dock reopens such a room on pages that are not its own. FB-100: on the Dashboard,
// a whole-project question went into the REQ-17 room, was refused after 20 s, and nothing on the
// panel said why. The notice names the room's scope and what its agent cannot read, and offers the
// one way to ask the project instead (ISS-277).

import { useCopy } from "@/lib/i18n/interface-language";

export function SubjectScopeNotice({
  kind,
  subjectKey,
  onAskProject,
}: {
  kind: string | null;
  subjectKey: string | null;
  onAskProject: () => void;
}) {
  const t = useCopy();
  const said =
    kind === "first_requirements"
      ? t("shell.dock.scopeFirstRequirements")
      : kind === "onboarding"
        ? t("shell.dock.scopeOnboarding")
        : t("shell.dock.scopeRequirement", { key: subjectKey ?? t("shell.dock.oneRequirement") });
  return (
    <div
      data-testid="subject-scope-notice"
      role="note"
      className="flex flex-none flex-col gap-1 border-b border-line bg-sunken px-3 py-2"
    >
      <p className="fg-body-sm text-fg">{said}</p>
      <button
        type="button"
        onClick={onAskProject}
        className="fg-caption self-start font-semibold text-link hover:underline"
      >
        {t("shell.dock.askWholeProject")}
      </button>
    </div>
  );
}
