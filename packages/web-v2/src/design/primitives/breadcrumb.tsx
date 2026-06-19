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
    // min-w-0 so children may shrink. Truncation is PER-CRUMB: intermediate
    // crumbs (e.g. a long project name) shrink+truncate, while the last crumb
    // (current page) and the "/" separators never shrink — so which page you're
    // on is always fully readable, even at 320px (ISS-514).
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
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
                  className="fg-body-sm min-w-0 shrink truncate text-left text-muted hover:text-fg"
                >
                  {c.label}
                </button>
              ) : (
                <a href={c.href} className="fg-body-sm min-w-0 shrink truncate text-muted hover:text-fg">
                  {c.label}
                </a>
              )
            ) : (
              <span
                className={
                  last
                    ? "fg-body-sm shrink-0 whitespace-nowrap font-semibold text-fg"
                    : "fg-body-sm min-w-0 shrink truncate text-muted"
                }
              >
                {c.label}
              </span>
            )}
            {!last && <span className="shrink-0 text-subtle">/</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}
