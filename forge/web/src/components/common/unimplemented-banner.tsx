'use client';

import { AlertTriangle } from 'lucide-react';

interface UnimplementedBannerProps {
  feature: string;
  hint?: string;
}

/**
 * Dev-only banner shown on pages whose backend endpoint has not yet been
 * ported to forge/core. The page still renders (skeletons, empty states)
 * so navigation remains smooth during Phase 2.6.
 */
export function UnimplementedBanner({ feature, hint }: UnimplementedBannerProps) {
  return (
    <div className="flex items-start gap-3 rounded border border-amber-500/40 bg-amber-500/10 p-4 text-amber-900 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-1 text-sm">
        <p className="font-medium">
          {feature} is not available yet
        </p>
        <p className="text-xs opacity-80">
          {hint ??
            'This page will return once the underlying endpoint ships on forge/core. Phase 2.6 kept the route alive to preserve navigation; no network request is made.'}
        </p>
      </div>
    </div>
  );
}
