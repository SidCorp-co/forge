export const PARK_PROTECTIONS = [
  'park-exempt-residency',
  'park-exempt-oneshot',
  'answer-resume-park',
] as const;

export type ParkProtection = (typeof PARK_PROTECTIONS)[number];
