import { Fragment } from "react";

export interface Crumb {
  label: string;
  href?: string;
}

export interface BreadcrumbProps {
  items: Crumb[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <Fragment key={`${c.label}-${i}`}>
            {c.href && !last ? (
              <a href={c.href} className="fg-body-sm text-muted hover:text-fg">
                {c.label}
              </a>
            ) : (
              <span className={last ? "fg-body-sm font-semibold text-fg" : "fg-body-sm text-muted"}>{c.label}</span>
            )}
            {!last && <span className="text-subtle">/</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}
