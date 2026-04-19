import type { Context } from 'koa';
import { run } from '../handlers/run';
import { status } from '../handlers/status';

export default {
  async run(ctx: Context) { return run(ctx); },
  async status(ctx: Context) { return status(ctx); },
};
