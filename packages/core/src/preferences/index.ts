export { preferenceRoutes as routes } from './routes.js';
export {
  ASSISTANT_PREFERENCE_DEFAULTS,
  type AssistantPreferencePatch,
  type AssistantPreferences,
  canonicalInstructions,
  listPreferenceChanges,
  type PreferenceActor,
  type PreferenceChange,
  PreferenceRestoreConflict,
  readAssistantPreferences,
  restorePreferenceChange,
  writeAssistantPreferences,
} from './service.js';
