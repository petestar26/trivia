import { clubById } from '@/lib/football/clubs';
import type { ReactNode } from 'react';
import { type BadgeGlyph } from '@socialplay/shared';

/** Original PlayQube club badges: a shield, the club's kit colours and a simple glyph. */
const FILL = (d: string): ReactNode => <path d={d} fill="currentColor" />;
const STROKE = (d: string): ReactNode => (
  <path
    d={d}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);

const GLYPHS: Record<BadgeGlyph, ReactNode> = {
  star: FILL('M12 4.5l2 4.4 4.8.5-3.6 3.2 1 4.7-4.2-2.5-4.2 2.5 1-4.7-3.6-3.2 4.8-.5z'),
  crown: FILL('M5.5 16.5l-.8-7 3.8 3L12 7l3.5 5.5 3.8-3-.8 7z'),
  wave: STROKE('M5 11.5q2-3 4 0t4 0 4 0M5 16q2-3 4 0t4 0 4 0'),
  bolt: FILL('M13 5L7 13h4l-1 6 7-8.5h-4z'),
  leaf: FILL('M6.5 17.5C6.5 10 10.5 6 17.5 6c0 7-4 11.5-11 11.5z'),
  anchor: (
    <>
      {STROKE('M12 8v10M8.5 11.5h7M7 14.5c.4 2.4 2.5 3.5 5 3.5s4.6-1.1 5-3.5')}
      <circle cx="12" cy="6.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </>
  ),
  peak: FILL('M4 17.5L9.5 8l3 5 2-3L20 17.5z'),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
      {STROKE(
        'M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M6.7 17.3l1.4-1.4M15.9 8.1l1.4-1.4'
      )}
    </>
  ),
  flame: FILL(
    'M12 4.5c.8 3.5 4.5 4.8 4.5 9a4.5 4.5 0 0 1-9 0c0-2.5 1.6-3.6 2.4-5.5.5.8.8 1.2 1.3 1.7.3-1.7.4-3.3.8-5.2z'
  ),
  key: (
    <>
      <circle cx="9" cy="9.5" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
      {STROKE('M11.2 11.7L18 18.5M15.2 15.7l2.3-2.3')}
    </>
  ),
  falcon: FILL(
    'M4 8.5c4.5 0 7 1.5 8 4.5 1-3 3.5-4.5 8-4.5-2.5 3.5-4.5 5-6.5 6.5L12 19l-1.5-4C8.5 13.5 6.5 12 4 8.5z'
  ),
  stag: STROKE(
    'M12 18.5V11M12 11L8 6.5M12 11l4-4.5M9.5 8.5H6.5M14.5 8.5h3M12 14l-3-2.5M12 14l3-2.5'
  ),
  thistle: (
    <>
      {FILL(
        'M8 10.5L8.5 5.5l2.2 2.5L12 5l1.3 3L15.5 5.5 16 10.5c0 2.2-1.8 3.5-4 3.5s-4-1.3-4-3.5z'
      )}
      {STROKE('M12 14v5M12 17l-3-1.5M12 17l3-1.5')}
    </>
  ),
  lion: FILL(
    'M12 4.5l1.5 3 3.2-1.2-.4 3.4 2.7 1.8-2.7 1.8.4 3.4-3.2-1.2L12 19.5l-1.5-3-3.2 1.2.4-3.4L5 12.3l2.7-1.8-.4-3.4 3.2 1.2z'
  ),
  fox: FILL('M5.5 5.5l4.5 3h4l4.5-3-.7 7.5L12 19l-5.8-6z'),
  gem: FILL('M8 6.5h8l3.5 4.5L12 18.5 4.5 11z'),
  tower: FILL('M8 19v-9H6.5V6.5H9v1.5h1.5V6.5h3V8H15V6.5h2.5V10H16v9z'),
  ring: (
    <>
      <circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
    </>
  ),
  shell: FILL('M12 18.5L5 11.5C7 6.5 17 6.5 19 11.5z'),
  arrow: FILL('M12 4.5l6 7h-3.8v7h-4.4v-7H6z'),
};

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) =>
  0.2126 * channel(parseInt(hex.slice(1, 3), 16)) +
  0.7152 * channel(parseInt(hex.slice(3, 5), 16)) +
  0.0722 * channel(parseInt(hex.slice(5, 7), 16));
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** The glyph colour that reads best on the badge: the club's own secondary when it does. */
export function badgeInk(primary: string, secondary: string) {
  if (ratio(primary, secondary) >= 3) return secondary;
  return ratio(primary, '#ffffff') >= ratio(primary, '#10151f') ? '#ffffff' : '#10151f';
}

export function ClubBadge({
  club,
  size = 28,
  label = false,
}: {
  club: number;
  size?: number;
  label?: boolean;
}) {
  const c = clubById(club);
  const { primary, secondary } = c.home;
  const ink = badgeInk(primary, secondary);
  return (
    <svg
      className="vf-badge"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? 'img' : undefined}
      aria-label={label ? c.name : undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path
        d="M12 1.5L21 4.5V12c0 5.5-4 9.5-9 11-5-1.5-9-5.5-9-11V4.5z"
        fill={primary}
        stroke={secondary === primary ? ink : secondary}
        strokeWidth="1.4"
      />
      <g style={{ color: ink }}>{GLYPHS[c.glyph]}</g>
    </svg>
  );
}
