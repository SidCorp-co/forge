/** The identity port: the sign-in providers the auth door reaches, named by role. */
export { githubProvider } from './github.js';
export { googleProvider, oidcProvider } from './oidc-provider.js';
export type {
  AuthorizeArgs,
  CallbackArgs,
  OAuthIdentity,
  OAuthProvider,
  ProviderConfig,
  ProviderId,
} from './types.js';
