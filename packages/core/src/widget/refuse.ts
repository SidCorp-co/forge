import type { WidgetRefusalCode } from '@forge/contracts/widget';
import { refuser } from '../lib/refusal.js';

/** Every widget refusal: one of the contract's codes, its status read from the contract's table. */
export const refuse = refuser<WidgetRefusalCode>('WIDGET_REFUSED');
