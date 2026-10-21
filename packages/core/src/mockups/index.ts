export { commentOnMockup, mockupCommentsAs } from './comments.js';
export { getMockupAs, listMockupsAs, mockupBytes } from './list.js';
export { mockupForChat, mockupKeysOf, mockupRefIn } from './ref.js';
export {
  acceptMockup,
  deleteFeedbackMockups,
  feedbackMockupsOf,
  proposeMockup,
  returnMockup,
  withdrawMockup,
} from './service.js';

import { mockupKeysOf, mockupRefIn } from './ref.js';
import { deleteFeedbackMockups, feedbackMockupsOf } from './service.js';

/**
 * The mockups half of feedback's `FeedbackDependents` port, which the composition root hands in: an
 * item's mockups read and deleted with its reporter data, and the mockup an item is filed about.
 */
export const mockupsForFeedback = {
  deleteMockups: deleteFeedbackMockups,
  mockupsOf: feedbackMockupsOf,
  mockupRefIn,
  mockupKeysOf,
};
