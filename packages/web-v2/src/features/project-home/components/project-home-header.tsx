// The project home's header: the project's name, drawn in the top bar, and nothing on the page under it
// (ISS-903): no mark beside a name the bar already says. Its settings are the palette's act (⌘K) beside
// the rail's own way in, so no row is spent on one icon.

import { PageTitle, usePageCommands } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

export function ProjectHomeHeader({ project, onSettings }: { project: { name: string }; onSettings: () => void }) {
  const t = useCopy();
  usePageCommands([{ label: t("dash.projectSettings"), icon: "settings", onRun: onSettings }]);
  return <PageTitle>{project.name}</PageTitle>;
}
