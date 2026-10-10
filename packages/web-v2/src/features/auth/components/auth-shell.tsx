import { PageTitle } from "@/design";
import Image from 'next/image';
import type { ReactNode } from 'react';
import { assetPath } from '@/lib/asset';
import { productCopy } from "@/lib/i18n/product-copy";

interface AuthShellProps {
  title: string;
  /** A line of state under the title, where the page has one. */
  subtitle?: string;
  children: ReactNode;
  /** Optional line under the card (e.g. the "create account" / "sign in" link). */
  footer?: ReactNode;
}

// Drawn by server pages (login, register) as well as client ones, so it reads copy without a hook;
// the copy is English only, so the interface language changes nothing here.
const t = productCopy();

export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-app px-4 py-10">
      <div className="w-95 max-w-full">
        {/* Brand */}
        <div className="mb-7 flex flex-col items-center gap-4">
          {/* preload: the mark is above the fold, so it is fetched at once rather than lazily */}
          <Image src={assetPath('/forge-mark-180.png')} alt={t("auth.brand")} width={60} height={60} preload unoptimized />
          <div className="fg-h2 text-center">{t("auth.brand")}</div>
        </div>

        {/* The form sits flush on the page: a hairline above it, no box */}
        <div className="border-t border-line-subtle pt-6">
          <PageTitle className="fg-h3">{title}</PageTitle>
          {subtitle ? <p className="fg-body-sm mb-5 mt-1">{subtitle}</p> : <div className="mb-5" />}
          {children}
        </div>

        {footer ? <p className="fg-body-sm mt-4 text-center">{footer}</p> : null}
      </div>
    </div>
  );
}
