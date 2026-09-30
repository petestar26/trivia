/** Internal calculations use whole units and bigint, never floating point. */
export const MAX_UNITS = 9_223_372_036_854_775_807n;

export function units(value: bigint, name: string, positive = false): bigint {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > MAX_UNITS) {
    throw new RangeError(`${name} must be ${positive ? 'positive' : 'nonnegative'} whole units within int64`);
  }
  return value;
}

export function total(values: readonly bigint[], name: string): bigint {
  return units(values.reduce((sum, value) => sum + units(value, name), 0n), name);
}

export function identifier(value: string, name: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(value)) {
    throw new RangeError(`${name} is invalid`);
  }
}
