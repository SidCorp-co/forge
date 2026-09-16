/** Permissive read-shape for a Google `config` jsonb. `clientEmail` and `projectId` are read back
 *  out of the stored key by the healthcheck; `defaultSpreadsheetId` is binding tier. */
export interface GoogleReadConfig {
  clientEmail?: string;
  projectId?: string;
  defaultSpreadsheetId?: string;
}
