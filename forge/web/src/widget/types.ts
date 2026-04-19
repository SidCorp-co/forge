export interface WidgetConfig {
  apiKey: string;
  apiUrl: string;
  position?: 'bottom-right' | 'bottom-left';
  hubToken?: string;
  hubContext?: Record<string, unknown>;
  theme?: { primaryColor?: string };
}
