import type { CoolifyTargetInput } from "@forge/contracts";

/** Permissive read-shape for a Coolify connection or binding `config` jsonb. */
export interface CoolifyReadConfig {
  /** Connection tier — the Coolify server. */
  baseUrl?: string;
  /** Binding tier — the applications this project deploys. */
  targets?: CoolifyTargetInput[];
}
