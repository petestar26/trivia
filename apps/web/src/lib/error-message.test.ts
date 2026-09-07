import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './error-message';

describe('getErrorMessage', () => {
  it('reads the flattened shape ApiClient actually throws', () => {
    // ApiClient.request() throws JSON.stringify({ status, ...error }) — code
    // and message sit at the top level, with no nested `error` key.
    const err = new Error(
      JSON.stringify({ status: 401, code: 'UNAUTHORIZED', message: 'Invalid credentials' }),
    );
    expect(getErrorMessage(err, 'Login failed')).toBe('Invalid credentials');
  });

  it('still reads the older nested shape', () => {
    const err = new Error(JSON.stringify({ error: { code: 'CONFLICT', message: 'Email already registered' } }));
    expect(getErrorMessage(err, 'Registration failed')).toBe('Email already registered');
  });

  it('returns plain-text messages instead of throwing on them', () => {
    // The old code called JSON.parse on this and threw inside the caller's
    // catch block, so no error was rendered at all.
    expect(getErrorMessage(new TypeError('Failed to fetch'), 'Login failed')).toBe('Failed to fetch');
  });

  it('falls back rather than leaking a payload with no user-facing message', () => {
    const err = new Error(JSON.stringify({ status: 500, code: 'INTERNAL', trace: 'at foo (bar.js:1:1)' }));
    expect(getErrorMessage(err, 'Login failed')).toBe('Login failed');
  });

  it('falls back for empty, non-Error and non-object values', () => {
    expect(getErrorMessage(new Error(''), 'Login failed')).toBe('Login failed');
    expect(getErrorMessage(new Error('   '), 'Login failed')).toBe('Login failed');
    expect(getErrorMessage(undefined, 'Login failed')).toBe('Login failed');
    expect(getErrorMessage(null, 'Login failed')).toBe('Login failed');
    expect(getErrorMessage({ some: 'object' }, 'Login failed')).toBe('Login failed');
    expect(getErrorMessage(new Error(JSON.stringify(['a', 'b'])), 'Login failed')).toBe('Login failed');
  });

  it('accepts a bare string throw', () => {
    expect(getErrorMessage('Something went wrong', 'Login failed')).toBe('Something went wrong');
  });

  it('ignores a blank message and uses the fallback', () => {
    const err = new Error(JSON.stringify({ status: 400, message: '   ' }));
    expect(getErrorMessage(err, 'Registration failed')).toBe('Registration failed');
  });
});
