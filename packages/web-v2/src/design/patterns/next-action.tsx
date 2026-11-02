// The screen's one next action, in the page header (REQ-11 BC-18, BC-22): the verb the person owes
// now (Answer, Approve, Cut, Triage), drawn once as the primary button in the shell's top bar, and
// nothing else competes with it. A screen's other acts go to the ⌘K palette (usePageCommands); while
// it named any, a quiet "more" control beside the button opens the palette on them.

import { buttonVariants } from "@/components/ui/button";
import type { ReactNode } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import type { IconName } from "../icons/icon";
import { Icon } from "../icons/icon";
import { Button } from "../primitives/button";
import { IconButton } from "../primitives/icon-button";
import { TopBarActions } from "../primitives/top-bar-slot";
import { usePageCommandsOpener } from "./page-commands";

type NextActionProps = {
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  testId?: string;
} & (
  | { label: string; onClick: () => void; href?: undefined; children?: undefined }
  | { label: string; href: string; onClick?: undefined; children?: undefined }
  | { label: string; href?: undefined; onClick?: undefined; children?: undefined }
  /** An act that carries its own confirm step or form (a sign-off with a reason), drawn as it is. */
  | { children: ReactNode; label?: undefined; href?: undefined; onClick?: undefined }
);

const PRIMARY = buttonVariants({ variant: "default", size: "sm" });

export function NextAction({ label, children, icon, disabled, loading, testId, ...act }: NextActionProps) {
  const t = useCopy();
  const more = usePageCommandsOpener();
  return (
    <TopBarActions>
      <span className="inline-flex items-center gap-1" data-next-action-bar="">
        {children ? (
          <span className="contents" data-next-action="" data-testid={testId}>
            {children}
          </span>
        ) : act.href !== undefined ? (
          <Link href={act.href} className={PRIMARY} data-next-action="" data-testid={testId}>
            {icon ? <Icon name={icon} size={15} /> : null}
            {label}
          </Link>
        ) : act.onClick ? (
          <Button variant="primary" size="sm" icon={icon} disabled={disabled} loading={loading} onClick={act.onClick} data-next-action="" data-testid={testId}>
            {label}
          </Button>
        ) : null}
        {more ? <IconButton icon="more" size="sm" aria-label={t("shell.palette.more")} title={t("shell.palette.more")} onClick={more} data-page-more="" /> : null}
      </span>
    </TopBarActions>
  );
}
