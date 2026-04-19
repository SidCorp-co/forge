import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  'users-permissions': {
    config: {
      jwt: {
        expiresIn: env('USERS_PERMISSIONS_JWT_EXPIRES_IN', '365d'),
      },
    },
  },
});

export default config;
