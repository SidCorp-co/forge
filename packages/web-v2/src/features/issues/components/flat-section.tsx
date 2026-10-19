import type { ReactNode } from "react";

/**
 * A main-column section drawn flat: a hairline above, a label heading, then its content. `action`
 * sits at the heading's far edge, so a section that can be edited keeps its button on the heading
 * line and not in a box of its own.
 */
export function FlatSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="border-t border-line-subtle pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="fg-label">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
