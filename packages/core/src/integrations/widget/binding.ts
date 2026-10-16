import {
  WIDGET_SITE_KEY_PATTERN,
  type WidgetBindingConfig,
  widgetBindingConfigSchema,
} from '@forge/contracts/widget';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  findActiveBindingByConfigValue,
  findBindingWithConnectionById,
} from '../index.js';

/** One live widget binding, as the public routes serve it. */
export interface WidgetBinding {
  bindingId: string;
  projectId: string;
  config: WidgetBindingConfig;
  /** The binding's own secret a client backend signs a visitor's identity with. */
  signingSecret: string | null;
}

function servedAs(pair: BindingWithConnection): WidgetBinding {
  const ctx = buildContextFromBinding<Record<string, unknown>, Record<string, never>>(pair);
  const parsed = widgetBindingConfigSchema.safeParse(ctx.config);
  if (!parsed.success) {
    // the binding document's schema admitted this config when it was written, so a row that no
    // longer parses is a fault in what was stored, never something to serve around
    throw new Error(
      `widget: binding ${pair.binding.id} holds a config the widget cannot serve (${parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ')})`,
    );
  }
  return {
    bindingId: pair.binding.id,
    projectId: pair.binding.projectId,
    config: parsed.data,
    signingSecret: ctx.integrationSecret ?? null,
  };
}

/**
 * The live binding a site key names: switched on, on a live connection. Null for a key no binding
 * holds, or one whose binding was switched off.
 */
export async function activeWidgetBinding(
  by: { siteKey: string } | { bindingId: string },
): Promise<WidgetBinding | null> {
  if ('siteKey' in by) {
    if (!WIDGET_SITE_KEY_PATTERN.test(by.siteKey)) return null;
    const pair = await findActiveBindingByConfigValue('widget', 'siteKey', by.siteKey);
    return pair ? servedAs(pair) : null;
  }
  const pair = await findBindingWithConnectionById(by.bindingId);
  if (pair?.binding.provider !== 'widget') return null;
  if (!pair.binding.active || !pair.connection.active) return null;
  return servedAs(pair);
}
