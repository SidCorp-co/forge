export function entryOf(obj, key) {
  if (obj == null || !Object.hasOwn(obj, key)) return undefined;
  return Object.prototype.propertyIsEnumerable.call(obj, key) ? obj[key] : undefined;
}
