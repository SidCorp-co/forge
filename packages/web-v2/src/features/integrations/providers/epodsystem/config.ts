/** Permissive read-shape for an Epodsystem `config` jsonb — every field is filled by the
 *  healthcheck out of the key, never typed, so none of them is guaranteed present. */
export interface EpodsystemReadConfig {
  storeId?: string;
  storeSlug?: string;
  storeName?: string;
  themeId?: string;
  themeName?: string;
  draftThemeId?: string;
  commerceEnabled?: boolean;
  domain?: string;
  orgId?: string;
  scopes?: string[];
}
