import { guideCall } from '../guides/index.js';
import type { ReviewOwed } from './ports.js';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const at = (r: ReviewOwed) =>
  r.status === 'awaiting_release' ? 'at `awaiting_release`' : 'at `in_progress`, its test step';

/** ISS-870: the reviews an independent judge owes, which no run declares unless the master does. */
export function reviewsLine(reviews: readonly ReviewOwed[]): string {
  if (reviews.length === 0) return '';
  const keys = reviews.map(
    (r) =>
      `${r.key} ${r.issueId} ${at(r)}, criteri${plural(r.criteria.length, 'on', 'a')} ${r.criteria.join(', ')}`,
  );
  return ` ${reviews.length} issue${plural(reviews.length, ' owes', 's owe')} an independent review (${keys.join('; ')}): this project's gate profile declares an independent judge (gate independent_qa), so no criterion named counts until a run other than its builder judges it, and no run is declared for it unless you declare one. Declare a judging run over each, \`--role qa\` for a criterion judged on the running build or \`--role reviewer\` for a code property judged against the diff, and have it record each criterion's verdict, or record why it waits; \`${guideCall('qa')}\` is how.`;
}
