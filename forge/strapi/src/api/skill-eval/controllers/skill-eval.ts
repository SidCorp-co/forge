import { factories } from '@strapi/strapi';
import { generateScorecard, formatForDream } from '../../../services/skill-eval';

const SKILL_EVAL_UID = 'api::skill-eval.skill-eval' as any;

export default factories.createCoreController(SKILL_EVAL_UID, ({ strapi }) => ({
  async scorecard(ctx) {
    const project = ctx.state.forgeProject;
    if (!project) {
      return ctx.badRequest('Missing project context');
    }

    const period = (ctx.query.period as 'd7' | 'd30' | 'd90') || 'd7';
    if (!['d7', 'd30', 'd90'].includes(period)) {
      return ctx.badRequest('Invalid period. Use d7, d30, or d90.');
    }

    const scorecard = await generateScorecard(strapi, project.documentId, period);
    const dreamInput = formatForDream(scorecard);

    // Persist the snapshot
    await strapi.documents(SKILL_EVAL_UID).create({
      data: {
        project: project.documentId,
        period,
        scorecard,
        dreamInput,
        generatedAt: scorecard.generatedAt,
      },
    });

    ctx.body = { scorecard, dreamInput };
  },
}));
