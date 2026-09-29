import { describe, expect, it } from 'vitest';
import { parseWholeNumberInput, wholeNumberRangeError } from './whole-number-input';

describe('whole number game inputs', () => {
  it('parses only safe whole-number strings', () => {
    expect(parseWholeNumberInput('50')).toBe(50);
    expect(parseWholeNumberInput(' 50 ')).toBe(50);
    expect(parseWholeNumberInput('')).toBeNull();
    expect(parseWholeNumberInput('50.5')).toBeNull();
    expect(parseWholeNumberInput('-1')).toBeNull();
    expect(parseWholeNumberInput('9007199254740992')).toBeNull();
  });

  it('describes missing, fractional, and out-of-range values without coercion', () => {
    expect(wholeNumberRangeError('', 5, 1000, 'Bet amount')).toBe('Bet amount must be a whole number.');
    expect(wholeNumberRangeError('5.5', 5, 1000, 'Bet amount')).toBe('Bet amount must be a whole number.');
    expect(wholeNumberRangeError('4', 5, 1000, 'Bet amount')).toBe('Bet amount must be at least 5.');
    expect(wholeNumberRangeError('1001', 5, 1000, 'Bet amount')).toBe('Bet amount must be no more than 1000.');
    expect(wholeNumberRangeError('50', 5, 1000, 'Bet amount')).toBeNull();
  });
});
