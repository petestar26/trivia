// Bank fields are configured by the platform; normalize their labels before translation.
export function paymentFieldLabel(field: string): string {
  const key = field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase();
  if (key === 'iban') return 'IBAN';
  if (key === 'swift code') return 'SWIFT code';
  return key.charAt(0).toUpperCase() + key.slice(1);
}
