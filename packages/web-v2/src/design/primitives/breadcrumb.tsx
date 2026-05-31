import { Fragment } from "react";

export interface Crumb {
  label: string;
  href?: string;
}

export interface BreadcrumbProps {
  items: Crumb[];
  /**
   * When provided, links render as buttons that call this with the crumb's
   * `href` — use it for client-side navigation (router.push) so the app's
   * basePath isn't escaped. Without it, crumbs fall back to raw `<a href>`.
   */
  onNavigate?: (href: string) => void;
}

export function Breadcrumb({ items, onNavigate }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        const linkable = c.href && !last;
        return (
          <Fragment key={`${c.label}-${i}`}>
            {linkable ? (
              onNavigate ? (
                <button
                  type="button"
                  onClick={() => onNavigate(c.href!)}
                  className="fg-body-sm text-muted hover:text-fg"
                >
                  {c.label}
                </button>
              ) : (
                <a href={c.href} className="fg-body-sm text-muted hover:text-fg">
                  {c.label}
                </a>
              )
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
