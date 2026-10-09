// What a witness entry hands `run.mjs` on `window.__witness`: its cases, when it is ready, and either
// a probe read once per case or stages run in order on one load.

export interface WitnessCase {
  name: string;
  width: number;
}

export type WitnessEntry = { cases: WitnessCase[]; ready: () => boolean } & (
  | { probe: () => string[] }
  | { stages: { name: string; run: () => string[] | Promise<string[]> }[] }
);

declare global {
  interface Window {
    __witness?: WitnessEntry;
  }
}
