'use client';

import { AlertBanner } from '@/components/ui';

interface SectionSaveBarProps {
  isDirty: boolean;
  isSubmitting: boolean;
  isError: boolean;
  isSuccess: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
  savingLabel?: string;
  successLabel?: string;
  errorLabel?: string;
}

export function SectionSaveBar({
  isDirty,
  isSubmitting,
  isError,
  isSuccess,
  onSave,
  onDiscard,
  saveLabel = 'Save',
  savingLabel = 'Saving…',
  successLabel = 'Saved successfully.',
  errorLabel = 'Failed to save. Please try again.',
}: SectionSaveBarProps) {
  return (
    <div className="space-y-3 pt-4">
      {isError && <AlertBanner variant="error">{errorLabel}</AlertBanner>}
      {isSuccess && (
        <div className="rounded-sm border border-success/30 bg-success-surface p-3 text-[10px] font-bold uppercase tracking-widest text-success">
          {successLabel}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={isSubmitting || !isDirty}
          className="bg-gradient-to-br from-primary to-tertiary text-on-primary px-6 py-2 text-[10px] font-black uppercase tracking-[0.15em] rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? savingLabel : saveLabel}
        </button>
        {isDirty && (
          <button
            type="button"
            onClick={onDiscard}
            disabled={isSubmitting}
            className="text-[10px] font-medium uppercase tracking-[0.15em] text-on-surface-variant hover:text-on-surface disabled:opacity-50"
          >
            Discard
          </button>
        )}
      </div>
    </div>
  );
}
