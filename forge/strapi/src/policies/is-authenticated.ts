/**
 * Policy: is-authenticated
 * Ensures the request has a valid users-permissions JWT.
 */
import { errors } from '@strapi/utils';

export default (policyContext) => {
  const user = policyContext.state?.user;

  if (!user) {
    throw new errors.UnauthorizedError('Authentication required');
  }

  return true;
};
