import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TOGETHER_GAMES, togetherGameGuide } from '@socialplay/shared';
import { LanguageProvider, useLanguage } from '@/providers/language-provider';
import { GroupSocialNav } from '@/components/groups/group-social-nav';
import { TogetherSelection } from '@/pages/play-together-selection';
import { catalogue, validateCatalogue } from './catalogue';
import { LANGUAGES } from './types';
import { translate } from './format';
import {
  groupErrorNotice,
  groupNumericInput,
  useTogetherNotice,
  useTogetherText,
} from './together-text';
import groups1 from './catalogues/groups-ui-1';
import groups3 from './catalogues/groups-ui-3';

afterEach(() => {
  cleanup();
  localStorage.removeItem('salem-language');
  vi.restoreAllMocks();
});
it('provides every language and preserves every interpolation in group copy', () => {
  expect(validateCatalogue({ ...groups1, ...groups3 })).toEqual([]);
  for (const game of TOGETHER_GAMES) {
    const guide = togetherGameGuide(game.key);
    for (const key of [
      game.name,
      game.rules,
      guide.selectionLabel,
      guide.choiceNote,
      guide.tieRule,
      ...guide.mechanics,
    ]) {
      expect(catalogue[key], key).toBeDefined();
      for (const { code } of LANGUAGES.filter((item) => item.code !== 'en'))
        expect(catalogue[key]?.[code], code + ': ' + key).toBeTruthy();
    }
  }
});
it.each(LANGUAGES)(
  'translates game selection and keeps entry values unchanged in $code',
  ({ code }) => {
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
      key === 'salem-language' ? code : null
    );
    const changed = vi.fn();
    render(
      <LanguageProvider>
        <TogetherSelection
          game="neon_hounds_3d"
          selected={[2]}
          disabled={false}
          onChange={changed}
          crashText=""
          onCrashText={() => {}}
        />
      </LanguageProvider>
    );
    const key = 'Choose dog {number}';
    fireEvent.click(screen.getByRole('button', { name: translate(code, key, { number: 8 }) }));
    expect(changed).toHaveBeenCalledWith([8]);
    expect(document.documentElement.dir).toBe(code === 'ar' ? 'rtl' : 'ltr');
  }
);
it.each(['٢٫٥٠', '۲٫۵۰', '2,50'])(
  'accepts locale decimal input %s without changing its canonical target',
  (value) => {
    const changed = vi.fn();
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
      key === 'salem-language' ? 'ar' : null
    );
    render(
      <LanguageProvider>
        <TogetherSelection
          game="sky_crash"
          selected={[]}
          disabled={false}
          onChange={changed}
          crashText=""
          onCrashText={() => {}}
        />
      </LanguageProvider>
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value } });
    expect(changed).toHaveBeenCalledWith([250]);
    expect(groupNumericInput(value)).toBe('2.50');
  }
);
it('keeps the games tab active in another language and preserves navigation destinations', () => {
  vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
    key === 'salem-language' ? 'ar' : null
  );
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={['/play-together/rounds/example']}>
        <GroupSocialNav groupId="group-id" roundOpen showRoundActivity={false} />
      </MemoryRouter>
    </LanguageProvider>
  );
  const games = screen.getByRole('link', { name: translate('ar', 'Games') });
  expect(games).toHaveClass('group-nav-active');
  expect(games).toHaveAttribute('href', '/groups/group-id/games');
});
it('updates a stored notice on language change and never translates its user-supplied values', () => {
  function Notice() {
    const [notice, setNotice] = useTogetherNotice();
    const { setLanguage } = useLanguage();
    return (
      <>
        <button
          onClick={() =>
            setNotice({
              message: 'Copy this round link: {url}',
              values: { url: 'https://salem.bet/rounds/Home' },
            })
          }
        >
          notice
        </button>
        <button onClick={() => setLanguage('fr')}>language</button>
        <p role="status">{notice}</p>
      </>
    );
  }
  render(
    <LanguageProvider>
      <Notice />
    </LanguageProvider>
  );
  fireEvent.click(screen.getByText('notice'));
  fireEvent.click(screen.getByText('language'));
  expect(screen.getByRole('status')).toHaveTextContent(
    translate('fr', 'Copy this round link: {url}', { url: 'https://salem.bet/rounds/Home' })
  );
});
it('shows a translated fallback for unknown server errors and retains minor-unit accounting', () => {
  function Example() {
    const [notice, setNotice] = useTogetherNotice();
    const { money, rankDetail } = useTogetherText();
    return (
      <>
        <button
          onClick={() =>
            setNotice(
              groupErrorNotice(new Error('Unexpected backend text'), 'Entry was not accepted.')
            )
          }
        >
          error
        </button>
        <p role="status">{notice}</p>
        <span>{money(1234, 'ETB')}</span>
        <p>{rankDetail('Runner 8 finished #2')}</p>
      </>
    );
  }
  vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
    key === 'salem-language' ? 'ar' : null
  );
  render(
    <LanguageProvider>
      <Example />
    </LanguageProvider>
  );
  fireEvent.click(screen.getByText('error'));
  expect(screen.getByRole('status')).toHaveTextContent(translate('ar', 'Entry was not accepted.'));
  expect(screen.getByRole('status')).not.toHaveTextContent('Unexpected backend text');
  expect(screen.getByText(/١٢٫٣٤/)).toBeInTheDocument();
  expect(
    screen.getByText(translate('ar', 'Runner {number} finished #{place}', { number: 8, place: 2 }))
  ).toBeInTheDocument();
});
