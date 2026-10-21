export { recordApplied, recordAppliedFromText } from './applied.js';
export { type LessonAudience, lessonsBlockFor, lessonsBlockText, RAISE_BY_DOOR } from './block.js';
export { raiseConfusion } from './confusions.js';
export { registerLessonCorrections } from './consumers.js';
export { type CorrectionInput, recordCorrection } from './corrections.js';
export { proposeLesson } from './decide.js';
export {
  checksOwed,
  type GatherCorrection,
  type GatherLesson,
  gatherInput,
  linkRepeats,
  type OwedCheck,
  projectsWithLessonWork,
  proposeRetirements,
  recordCheckIssue,
} from './gather.js';
export { provideLessonsPorts } from './ports.js';
export { lessonRoutes } from './routes.js';
