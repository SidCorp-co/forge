'use client';

// Stub — the legacy settings form wrote to Strapi-only fields. The rewired
// settings surface lands in a follow-up within Phase 2.6-F2.

export function useSettingsForm() {
  return {
    isDirty: false,
    isSubmitting: false,
    save: async () => {},
    reset: () => {},
  };
}
