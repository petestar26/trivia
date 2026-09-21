import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './safe-return-to';

const ORIGIN = 'https://app.example.test';
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);
const loc = (pathname: unknown, search?: unknown, hash?: unknown) => ({ pathname, search, hash, state: null, key: 'k' });
const check = (from: unknown) => safeReturnTo(from, ORIGIN);

describe('safeReturnTo — accepts plain in-app locations and keeps ALL of them', () => {
  it.each([
    [loc('/groups/invite/abc123'), '/groups/invite/abc123'],
    [loc('/groups/invite/abc123', '?ref=email&x=1'), '/groups/invite/abc123?ref=email&x=1'],
    [loc('/groups/g-1', '', '#members'), '/groups/g-1#members'],
    [loc('/groups/invite/t', '?a=1', '#frag'), '/groups/invite/t?a=1#frag'],
    [loc('/'), '/'],
    [loc('/wallet', undefined, undefined), '/wallet'],
    [{ pathname: '/rewards' }, '/rewards'],
    [loc('/games/trivia', '?category=Science%20%26%20Nature'), '/games/trivia?category=Science%20%26%20Nature'],
    // Percent-encoding that is NOT hostile stays as written.
    [loc('/search/50%25'), '/search/50%25'],
    [loc('/files/a%2Fb'), '/files/a%2Fb'],
    [loc('/caf%C3%A9'), '/caf%C3%A9'],
    [loc('/groups/g%2D1'), '/groups/g%2D1'],
    [loc('/groups/x:y'), '/groups/x:y'],
    // Benign paths that are encoded more than once are still within the decode bound.
    [loc('/a%2541b'), '/a%2541b'],
    [loc('/a%252520b'), '/a%252520b'],
    [loc('/groups/invite/t', '?next=https%3A%2F%2Fexample.test%2Fx'), '/groups/invite/t?next=https%3A%2F%2Fexample.test%2Fx'],
  ])('%j -> %s', (from, expected) => {
    expect(check(from)).toBe(expected);
  });

  it('returns the RESOLVED form — dot segments collapsed as the browser would — not the raw input', () => {
    expect(check(loc('/groups/../wallet'))).toBe('/wallet');
    expect(check(loc('/a/./b'))).toBe('/a/b');
  });
});

describe('safeReturnTo — falls back to "/" for anything that is not a plain in-app location', () => {
  const hostile: Array<[string, unknown]> = [
    ['no state at all', undefined],
    ['null', null],
    ['a bare string path', '/wallet'],
    ['an absolute URL string', 'https://evil.example/steal'],
    ['a number', 42],
    ['an array', ['/wallet']],
    ['pathname is not a string', loc(42)],
    ['pathname missing', {}],
    ['search is not a string', loc('/wallet', 5)],
    ['hash is not a string', loc('/wallet', '', { a: 1 })],
    ['empty pathname', loc('')],
    ['protocol-relative //host', loc('//evil.example')],
    ['protocol-relative //host/path', loc('//evil.example/wallet')],
    ['triple slash', loc('///evil.example')],
    ['backslash after slash', loc('/\\evil.example')],
    ['backslash anywhere in the path', loc('/wallet\\..\\..\\evil')],
    ['scheme in the pathname', loc('https://evil.example/x')],
    ['javascript: scheme', loc('javascript:alert(1)')],
    ['data: scheme', loc('data:text/html,hi')],
    ['no leading slash', loc('wallet')],
    ['relative dot path', loc('./wallet')],
    ['TAB smuggling a second slash', loc('/' + TAB + '/evil.example')],
    ['LF smuggling a second slash', loc('/' + LF + '/evil.example')],
    ['CR smuggling a second slash', loc('/' + CR + '/evil.example')],
    ['NUL in the path', loc('/wallet' + NUL)],
    ['DEL in the path', loc('/wallet' + DEL)],
    ['control character in the query', loc('/wallet', '?a=' + LF + 'b')],
    ['control character in the fragment', loc('/wallet', '', '#a' + TAB)],
    ['search that does not start with ?', loc('/wallet', 'evil')],
    ['hash that does not start with #', loc('/wallet', '', 'evil')],
    ['dot segments that collapse into //', loc('/a/..//evil.example')],
    ['encoded dot segments that collapse into //', loc('/%2e%2e//evil.example')],
    ['the login page (would loop)', loc('/login')],
    ['a login sub-path', loc('/login/again', '?x=1')],
    ['the register page', loc('/register')],
    ['forgot-password', loc('/forgot-password')],
    ['login reached through dot segments', loc('/groups/../login')],
    ['an oversized location', loc('/' + 'a'.repeat(3000))],
    // ── hostile only once DECODED ──
    ['encoded protocol-relative (%2F%2F)', loc('/%2F%2Fevil.example')],
    ['encoded protocol-relative, lower-case hex', loc('/%2f%2fevil.example')],
    ['one encoded slash after the root slash (//)', loc('/%2Fevil.example')],
    ['encoded backslash (%5C)', loc('/%5Cevil.example')],
    ['encoded backslash, lower-case hex', loc('/%5cevil.example')],
    ['double-encoded protocol-relative (%252F)', loc('/%252F%252Fevil.example')],
    ['triple-encoded protocol-relative', loc('/%25252F%25252Fevil.example')],
    ['encoded TAB smuggling a second slash', loc('/%09/evil.example')],
    ['encoded CRLF', loc('/wallet%0d%0aSet-Cookie:x=1')],
    ['encoded NUL', loc('/wallet%00')],
    ['a scheme-looking first segment (javascript:)', loc('/javascript:alert(1)')],
    ['a scheme-looking first segment with an encoded colon', loc('/javascript%3Aalert(1)')],
    ['a scheme-looking first segment (data:)', loc('/data:text/html,hi')],
    ['an encoded external URL as the first segment', loc('/https%3A%2F%2Fevil.example')],
    ['a scheme-looking first segment behind an extra slash', loc('/.//https:evil')],
    // ── malformed as written ──
    ['a malformed escape (%ZZ)', loc('/%ZZ')],
    ['a lone percent sign', loc('/%')],
    ['a trailing percent sign', loc('/wallet%')],
    ['a truncated multi-byte escape', loc('/%E0%A4%A')],
    ['an overlong UTF-8 escape', loc('/%C0%AF')],
  ];

  it.each(hostile)('%s', (_name, from) => {
    expect(check(from)).toBe('/');
  });

  it('never throws, whatever it is handed', () => {
    const weird = [Symbol('x'), () => '/wallet', new Date(), /re/, { pathname: { toString: () => '/x' } }, Object.create(null)];
    for (const w of weird) expect(() => check(w)).not.toThrow();
  });

  it('a protocol-relative host is rejected however many times it is encoded — nested beyond the decode bound too', () => {
    const encode = (text: string, layers: number) => Array.from({ length: layers }).reduce<string>((acc) => encodeURIComponent(acc), text);
    for (let layers = 1; layers <= 9; layers++) {
      expect(check(loc('/' + encode('//evil.example', layers))), `${layers} layer(s) of encoding`).toBe('/');
      expect(check(loc('/' + encode('\\evil.example', layers))), `${layers} layer(s), backslash`).toBe('/');
    }
  });

  it('a look-alike prefix of an auth page is a different page and is allowed', () => {
    expect(check(loc('/login-help'))).toBe('/login-help');
    expect(check(loc('/registered-groups'))).toBe('/registered-groups');
  });
});
