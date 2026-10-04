"use client";

// A full page's sticky header is the shell's top bar: a back control named after where it goes
// ("← Issues"), the key, the title and the state badge, and exactly one primary action that changes
// with the state. No breadcrumb. Back lands on the list view the page was opened from — its mode,
// filters and open peek — kept in session storage per list; a page reached by a link goes to the
// plain list. Below 768px the bar is too narrow for the title, so it heads the main column instead.

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { PageTitle } from "../primitives/heading";
import { TopBarActions } from "../primitives/top-bar-slot";

const originKey = (list: string) => `web-v2:list-origin:${list}`;

/** Called as a list opens a full page: the list's own URL is where that page's back control goes. */
export function rememberListOrigin(list: string): void {
  try {
    sessionStorage.setItem(originKey(list), `${window.location.pathname}${window.location.search}`);
  } catch {}
}

/** Where "← List" goes: the remembered view of `listHref`, else `listHref` itself. */
export function useListOrigin(list: string, listHref: string): string {
  const [href, setHref] = useState(listHref);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(originKey(list));
      setHref(saved?.startsWith(listHref) ? saved : listHref);
    } catch {
      setHref(listHref);
    }
  }, [list, listHref]);
  return href;
}

export interface DetailHeaderProps {
  back: { href: string; label: string };
  itemKey?: string;
  title: ReactNode;
  badge?: ReactNode;
  /** The one primary action; secondary acts live where they act, never beside it. */
  action?: ReactNode;
  /** Hover text on the key, e.g. the row's uuid. */
  keyTitle?: string;
}

export function DetailHeader({ back, itemKey, title, badge, action, keyTitle }: DetailHeaderProps) {
  return (
    <>
      <PageTitle
        back={
          <Link
            href={back.href}
            className="inline-flex h-[30px] flex-none items-center gap-1.5 whitespace-nowrap rounded-sm bg-sunken pl-2 pr-2.5 text-13 font-semibold text-fg hover:bg-active"
            data-testid="detail-back"
            aria-label={`Back to ${back.label}`}
          >
            <span aria-hidden className="text-[15px] leading-none text-muted">
              ←
            </span>
            {back.label}
          </Link>
        }
        after={
          <span className="flex flex-none items-center gap-2 max-md:hidden">
            {itemKey ? (
              <span className="font-mono text-12 font-semibold text-muted" title={keyTitle}>
                {itemKey}
              </span>
            ) : null}
            {badge}
          </span>
        }
      >
        <span className="max-md:hidden">{title}</span>
      </PageTitle>
      {action ? <TopBarActions>{action}</TopBarActions> : null}
    </>
  );
}

/** The title block heading the main column below 768px, where the top bar only holds the back control. */
export function DetailMobileTitle({ itemKey, title, badge }: { itemKey?: string; title: ReactNode; badge?: ReactNode }) {
  return (
    <div className="px-4 pb-1 pt-4 md:hidden" data-testid="detail-mobile-title">
      <div className="flex flex-wrap items-center gap-2">
        {itemKey ? <span className="font-mono text-12 font-semibold text-muted">{itemKey}</span> : null}
        {badge}
      </div>
      <p className="mt-1 text-[19px] font-semibold leading-snug text-fg">{title}</p>
    </div>
  );
}
