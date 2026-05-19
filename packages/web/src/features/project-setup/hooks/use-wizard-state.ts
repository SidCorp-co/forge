'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  WIZARD_STEP_IDS,
  type StepStatus,
  type WizardStepId,
  type WizardStepStates,
} from '../types';

function emptyStates(): WizardStepStates {
  return WIZARD_STEP_IDS.reduce(
    (acc, id) => {
      acc[id] = { status: 'pending', error: null };
      return acc;
    },
    {} as WizardStepStates,
  );
}

export interface UseWizardStateResult {
  currentIndex: number;
  currentStep: WizardStepId;
  states: WizardStepStates;
  isFirst: boolean;
  isLast: boolean;
  goTo: (id: WizardStepId) => void;
  next: () => void;
  back: () => void;
  markStep: (id: WizardStepId, status: StepStatus, error?: string | null) => void;
}

/**
 * Local UI state for the wizard. NOT persisted — refresh starts over. Each
 * step writes directly to the backend on commit, so resetting the wizard
 * state is harmless.
 */
export function useWizardState(initial: WizardStepId = 'repository'): UseWizardStateResult {
  const initialIndex = Math.max(0, WIZARD_STEP_IDS.indexOf(initial));
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [states, setStates] = useState<WizardStepStates>(emptyStates);

  const currentStep = WIZARD_STEP_IDS[currentIndex] ?? 'repository';
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === WIZARD_STEP_IDS.length - 1;

  const goTo = useCallback((id: WizardStepId) => {
    const idx = WIZARD_STEP_IDS.indexOf(id);
    if (idx >= 0) setCurrentIndex(idx);
  }, []);

  const next = useCallback(() => {
    setCurrentIndex((i) => Math.min(WIZARD_STEP_IDS.length - 1, i + 1));
  }, []);

  const back = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, []);

  const markStep = useCallback(
    (id: WizardStepId, status: StepStatus, error?: string | null) => {
      setStates((s) => ({ ...s, [id]: { status, error: error ?? null } }));
    },
    [],
  );

  return useMemo(
    () => ({ currentIndex, currentStep, states, isFirst, isLast, goTo, next, back, markStep }),
    [currentIndex, currentStep, states, isFirst, isLast, goTo, next, back, markStep],
  );
}
