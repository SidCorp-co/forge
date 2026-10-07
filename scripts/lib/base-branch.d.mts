export type BaseRef =
  | { branch: string; source: string; ref: string; refusal?: undefined }
  | { refusal: string; summary: string; ref?: undefined };

export const PROVED_STEP: string;
export function baseRef(root: string, env?: NodeJS.ProcessEnv): BaseRef;
export function ciBranches(text: string): {
  push: string[] | null;
  pullRequest: string[] | null;
  proved: string[] | null;
};
