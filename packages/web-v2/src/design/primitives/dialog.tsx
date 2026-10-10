
// A modal: Base UI Dialog through shadcn, so focus trap, Escape, outside press and scroll lock are the
// primitive's. Title on top, the body, then the footer's acts at the right.

import type { ReactNode } from "react";
import { Dialog as Root, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils/cn";

// `wide` shows a reading at full width (a table opened wide), within the viewport's margin
const WIDTH = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl", wide: "sm:max-w-6xl" } as const;

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** One line under the title, read by assistive tech as the dialog's description. */
  description?: ReactNode;
  children?: ReactNode;
  /** The acts, primary last. */
  footer?: ReactNode;
  width?: keyof typeof WIDTH;
  testId?: string;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, width = "md", testId }: DialogProps) {
  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("gap-4 rounded-md border border-line bg-surface p-5 text-fg shadow-overlay ring-0", WIDTH[width])} data-testid={testId}>
        <DialogHeader>
          <DialogTitle className="fg-h3">{title}</DialogTitle>
          {description ? <DialogDescription className="fg-body-sm text-muted">{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        {footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </DialogContent>
    </Root>
  );
}
