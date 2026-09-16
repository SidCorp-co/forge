/** Permissive read-shape for a Rocket.Chat `config` jsonb. `serverUrl` is connection tier,
 *  `rids` binding tier. */
export interface RocketchatReadConfig {
  serverUrl?: string;
  rids?: string[];
}
