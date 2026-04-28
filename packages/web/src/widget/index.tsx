import '@/app/globals.css';
import { createRoot, type Root } from 'react-dom/client';
import { WidgetRoot } from './widget-root';
import type { WidgetConfig } from './types';

let root: Root | null = null;
let hostEl: HTMLDivElement | null = null;
let currentConfig: WidgetConfig | null = null;

function init(config: WidgetConfig) {
  currentConfig = config;
  if (!config.apiKey || !config.apiUrl) {
    console.error('[ForgeWidget] apiKey and apiUrl are required');
    return;
  }

  destroy();

  hostEl = document.createElement('div');
  hostEl.id = 'forge-widget-host';
  document.body.appendChild(hostEl);

  root = createRoot(hostEl);
  root.render(<WidgetRoot config={config} />);
}

function destroy() {
  if (root) {
    root.unmount();
    root = null;
  }
  if (hostEl) {
    hostEl.remove();
    hostEl = null;
  }
}

function setToken(hubToken: string) {
  if (!currentConfig) return;
  init({ ...currentConfig, hubToken });
}

function getConfig(): WidgetConfig | null {
  return currentConfig ? { ...currentConfig } : null;
}

// Expose on window
(window as any).ForgeWidget = { init, destroy, setToken, getConfig };

// Auto-init from script tag data attributes
const currentScript = document.currentScript as HTMLScriptElement | null;
if (currentScript) {
  const baseUrl = currentScript.src.replace(/\/forge-widget\.js.*$/, '');

  // Option 1: data-config (base64-encoded JSON: { k, p, c })
  if (currentScript.dataset.config) {
    try {
      const cfg = JSON.parse(atob(currentScript.dataset.config));
      init({
        apiKey: cfg.k,
        apiUrl: baseUrl,
        position: cfg.p || undefined,
        theme: cfg.c ? { primaryColor: cfg.c } : undefined,
      });
    } catch (e) {
      console.error('[ForgeWidget] Invalid data-config:', e);
    }
  }
  // Option 2: individual data attributes (legacy)
  else if (currentScript.dataset.apiKey) {
    init({
      apiKey: currentScript.dataset.apiKey,
      apiUrl: currentScript.dataset.apiUrl || baseUrl,
      position: (currentScript.dataset.position as 'bottom-right' | 'bottom-left') || undefined,
      hubToken: currentScript.dataset.hubToken || undefined,
      theme: currentScript.dataset.primaryColor ? { primaryColor: currentScript.dataset.primaryColor } : undefined,
    });
  }
}

export { init, destroy, setToken, getConfig };
