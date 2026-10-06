import { expect, it } from 'vitest';
import { inputToMinor, formatMinor, currencyMinorDigits } from './payment-money';

it('converts local payment input to exact minor units, never float multiplication', () => {
  expect(inputToMinor('300', 2)).toBe(30000);
  expect(inputToMinor('0.29', 2)).toBe(29);
  expect(inputToMinor('1.001', 2)).toBeNull();
  expect(inputToMinor('1e3', 2)).toBeNull();
  expect(inputToMinor('-1', 2)).toBeNull();
  expect(inputToMinor('21474836.48', 2)).toBeNull();
});
it('renders transaction amounts with correct currency precision', () => {
  expect(formatMinor('30000', 'ETB')).toBe('300.00 ETB');
  expect(formatMinor('25', 'USD')).toBe('0.25 USD');
  expect(formatMinor('9007199254740993', 'USD')).toBe('90071992547409.93 USD');
  expect(currencyMinorDigits('JPY')).toBe(0);
  expect(currencyMinorDigits('KWD')).toBe(3);
});
