import type { ForgeTool } from './tools';
import { setPreferredLanguage } from '../language-detect';

export const forgeLanguage: ForgeTool = {
  name: 'forge_language',
  description: 'Get or set the user\'s preferred output language. Use when user asks to change response language (e.g. "reply in Vietnamese", "switch to English").',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'] },
      language: { type: 'string', description: 'Language name (e.g. "Vietnamese", "English", "Japanese"). Required for set action.' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;
    const userKey = ctx.userKey || `project:${ctx.projectDocumentId}`;

    if (action === 'get') {
      const docs = ctx.strapi.documents('api::user-preference.user-preference');
      const existing = await docs.findMany({
        filters: { userKey: { $eq: userKey } },
        limit: 1,
      });
      const lang = existing[0]?.preferredLanguage;
      return lang ? `Preferred language: ${lang}` : 'No language preference set (defaults to English).';
    }

    if (action === 'set') {
      const language = input.language as string;
      if (!language) return 'Error: language is required for set action.';
      await setPreferredLanguage(ctx.strapi, ctx.projectDocumentId, userKey, language);
      return `Language preference set to: ${language}. All future responses will be in ${language}.`;
    }

    return `Unknown action: ${action}`;
  },
};
