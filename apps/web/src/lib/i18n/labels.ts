/** Display source-owned status/role codes without modifying their stored values.
 * Do not call this for names, user messages or signed receipt fields.
 */
export function interfaceCodeLabel(t: (message: string) => string, code: string): string {
  const label = code
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
  return t(label);
}
