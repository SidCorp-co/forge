import { PageTitle } from "@/design";
import type { ReactNode } from 'react';
import { assetPath } from '@/lib/asset';

interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  /** Optional line under the card (e.g. the "create account" / "sign in" link). */
  footer?: ReactNode;
}

export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-app px-4 py-10">
      <div className="w-[380px] max-w-full">
        {/* Brand */}
        <div className="mb-7 flex flex-col items-center gap-4">
          <img src={assetPath('/forge-mark-180.png')} alt="Forge" width={60} height={60} />
          <div className="text-center">
            <div className="fg-h2">Forge</div>
            <div className="fg-body-sm mt-0.5">Control plane for Claude Code</div>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-line bg-surface p-6 shadow-md">
          <PageTitle className="fg-h3">{title}</PageTitle>
          <p className="fg-body-sm mb-5 mt-1">{subtitle}</p>
          {children}
        </div>

        {footer && <p className="fg-body-sm mt-4 text-center">{footer}</p>}
      </div>
    </div>
  );
}
