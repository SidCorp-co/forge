import type { Context } from 'koa';

export default () => ({
  async status(ctx: Context) {
    const { getHeartbeatState } = await import('../../../services/heartbeat');
    ctx.body = { data: getHeartbeatState() };
  },

  async tick(ctx: Context) {
    const { forceHeartbeatTick } = await import('../../../services/heartbeat');
    const result = await forceHeartbeatTick(globalThis.strapi);
    ctx.body = { data: result };
  },

  async history(ctx: Context) {
    const { getHeartbeatHistory } = await import('../../../services/heartbeat');
    ctx.body = { data: getHeartbeatHistory() };
  },
});
