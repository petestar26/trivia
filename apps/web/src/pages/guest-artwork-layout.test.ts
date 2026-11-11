import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('guest artwork layout contract', () => {
  const css = readFileSync('src/pages/guest-browse.css', 'utf8');
  it('bounds artwork within the panel instead of intrinsic image height', () => {
    const rule = css.match(/\.salem-guest-picture\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('inset: 12px');
    expect(rule).toContain('height: calc(100% - 24px)');
    expect(rule).toContain('width: calc(100% - 24px)');
    expect(rule).toContain('object-fit: contain');
    expect(rule).not.toContain('260px');
  });
  it('finishes animation within two seconds and supports reduced motion', () => {
    expect(css).toContain('salem-picture-arrive 1800ms ease-in-out 1');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation: none !important');
  });
});
