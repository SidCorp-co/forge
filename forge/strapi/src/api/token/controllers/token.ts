/**
 * Token controller.
 * Generates a non-expiring JWT for users-permissions users.
 */

export default {
  async generate(ctx) {
    const { identifier, password } = ctx.request.body as { identifier?: string; password?: string };

    if (!identifier || !password) {
      ctx.status = 400;
      ctx.body = { error: 'identifier and password are required' };
      return;
    }

    // Find user by email or username
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: {
        $or: [{ email: identifier }, { username: identifier }],
      },
    });

    if (!user || user.blocked) {
      ctx.status = 401;
      ctx.body = { error: 'Invalid credentials' };
      return;
    }

    // Verify password
    const validPassword = await strapi
      .plugin('users-permissions')
      .service('user')
      .validatePassword(password, user.password);

    if (!validPassword) {
      ctx.status = 401;
      ctx.body = { error: 'Invalid credentials' };
      return;
    }

    // Issue a non-expiring JWT (100 years)
    const token = strapi.plugin('users-permissions').service('jwt').issue(
      { id: user.id },
      { expiresIn: '100y' },
    );

    ctx.body = {
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    };
  },
};
