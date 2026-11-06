import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const styles = import.meta.glob<string>('/src/**/*.css', {
  eager: true,
  query: '?raw',
  import: 'default',
});

// Accessible labels and hints change with the selected language. A stable class
// must own visual styling; presence selectors and state attributes remain safe.
function translatedTextSelectors(css: string): string[] {
  const invalid = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    if (/\[\s*(?:aria-label|title|placeholder)\s*[*^$~|]?=/i.test(rule.selector)) {
      invalid.add(rule.selector);
    }
  });
  return [...invalid];
}

describe('language-independent interface styling', () => {
  it('rejects label-value selectors, including prefix and substring matches', () => {
    expect(
      translatedTextSelectors(`
        button[aria-label='Send'] { color: white; }
        [aria-label^="Notifications"] { min-width: 44px; }
        input[placeholder*="Email"] { border: 1px solid; }
        [ title = "Close" i ] { display: block; }
      `)
    ).toHaveLength(4);
    expect(
      translatedTextSelectors(`
        .salem-sign-in-method button[aria-pressed='true'] { color: white; }
        [aria-label] { outline-offset: 2px; }
        .example::after { content: "[title='Example']"; }
      `)
    ).toEqual([]);
  });

  it('keeps every application stylesheet independent of translated labels', () => {
    expect(Object.keys(styles).length).toBeGreaterThan(20);
    const violations = Object.entries(styles).flatMap(([file, css]) =>
      translatedTextSelectors(css).map((selector) => ({ file, selector }))
    );
    expect(violations).toEqual([]);
  });
});
