/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API origin plus `/api`, where core is not the page's own origin; unset: `/api`. */
  readonly VITE_API_URL?: string;
  /** The socket URL, where it is not the API origin's `/ws`. */
  readonly VITE_WS_URL?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENV?: string;
  /** The commit this build is of, stamped by the image build. */
  readonly VITE_SOURCE_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
