/** Convert snake_case status/type values to human-readable labels */
export function formatStatusLabel(value: string): string {
  return value.replace(/_/g, ' ');
}
