'use client';

import { UnimplementedBanner } from '@/components/common/unimplemented-banner';

interface AntigravitySectionProps {
  previewMode?: boolean;
}

export function AntigravitySection({ previewMode = false }: AntigravitySectionProps) {
  return (
    <UnimplementedBanner
      feature="Antigravity runtime"
      hint={
        previewMode
          ? 'Coming v0.1.x — preview only. Antigravity provider wiring lands once the adapter is upstreamed.'
          : undefined
      }
    />
  );
}

export default AntigravitySection;
