// The shares domain: turns a frozen report document into a Forge link a reader opens, behind the
// ShareTarget port. No target hosts a document with a third party.

export type { ShareTarget } from '@forge/contracts/shares';
export { SHARE_REST_CARDS } from './cards.js';
export {
  provideShareSubjectSources,
  registerShareSubjectSource,
  type ShareSubjectSource,
} from './ports.js';
