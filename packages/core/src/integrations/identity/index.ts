/** The identity port: the sign-in providers the auth door reaches, named by role. */
export { githubProvider } from './github.js';
export { googleProvider, oidcProvider } from './oidc.js';
export { mailDeliveryEnabled, sendMail } from './smtp.js';
export type { OAuthIdentity, OAuthProvider, ProviderConfig, ProviderId } from './types.js';
