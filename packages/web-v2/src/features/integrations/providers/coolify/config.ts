import type { CoolifyTargetInput } from "@forge/contracts/integrations";

export interface CoolifyReadConfig {
  baseUrl?: string;
  targets?: CoolifyTargetInput[];
}
