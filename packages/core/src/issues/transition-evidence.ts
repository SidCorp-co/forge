export const isBlankPlan = (plan: string | null | undefined): boolean =>
  !plan || plan.trim().length === 0;
