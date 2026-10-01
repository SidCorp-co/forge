import { z } from 'zod';

const STAGES_RETIRED =
  "a binding carries no `stages`: which environment a deploy binding serves is the project document's, `environments.<name>.deployment.binding` (`PUT /api/projects/:id/config`), and production is the environment whose `tier` is `production`. Send this body without `stages`.";

export const retiredStagesField = z.never({ error: STAGES_RETIRED }).optional();
