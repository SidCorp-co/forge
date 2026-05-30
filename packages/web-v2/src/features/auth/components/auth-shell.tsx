import type { ReactNode } from 'react';
import { assetPath } from '@/lib/asset';

interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  /** Optional line under the card (e.g. the "create account" / "sign in" link). */
  footer?: ReactNode;
}

/**
 * Centered brand + card wrapper, mirroring the prototype `LoginScreen.jsx`:
 * a 380px column with the Forge mark + wordmark, then a surface card. Built
 * from kit tokens/utilities (no inline-style soup). Server-safe — no client
 * hooks — so it can be rendered from the server page components.
 */
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-app px-4 py-10">
      <div className="w-[380px] max-w-full">
        {/* Brand */}
        <div className="mb-7 flex flex-col items-center gap-4">
          {/* Plain <img> (not next/image) — small static mark; assetPath adds
              the basePath so it resolves under /v2. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={assetPath('/forge-mark-180.png')} alt="Forge" width={60} height={60} />
          <div className="text-center">
            <div className="fg-h2">Forge</div>
            <div className="fg-body-sm mt-0.5">Control plane for Claude Code</div>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-line bg-surface p-6 shadow-md">
          <h1 className="fg-h3">{title}</h1>
          <p className="fg-body-sm mb-5 mt-1">{subtitle}</p>
          {children}
        </div>

        {footer && <p className="fg-body-sm mt-4 text-center">{footer}</p>}
      </div>
    </div>
  );
}
