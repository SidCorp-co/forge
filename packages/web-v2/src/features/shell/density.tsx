'use client';

// Global display density (Comfortable / Compact). The chosen value is mirrored
// onto `<html data-density>` so plain CSS in globals.css can compact Table/Card
// padding without prop-drilling a density flag through every component.
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { usePersistedState } from '@/lib/utils/use-persisted-state';

export type Density = 'comfortable' | 'compact';

interface DensityCtx {
  density: Density;
  setDensity: (d: Density) => void;
}

const Ctx = createContext<DensityCtx | null>(null);

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = usePersistedState<Density>('web-v2:density', 'comfortable');

  // Reflect onto the document element so `[data-density="compact"]` CSS applies
  // globally. Runs after hydration (the persisted value lands in an effect).
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  return <Ctx.Provider value={{ density, setDensity }}>{children}</Ctx.Provider>;
}

export function useDensity(): DensityCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDensity must be used within <DensityProvider>');
  return ctx;
}
