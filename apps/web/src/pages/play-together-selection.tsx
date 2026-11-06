import { useTogetherText, groupNumericInput } from '@/lib/i18n/together-text';
import {
  togetherGame,
  togetherGameGuide,
  togetherCrashSurvivalPercent,
  type TogetherGame,
} from '@socialplay/shared';

export function TogetherSelection({
  game: key,
  selected,
  disabled,
  onChange,
  crashText,
  onCrashText,
}: {
  game: TogetherGame;
  selected: number[];
  disabled: boolean;
  onChange: (selection: number[]) => void;
  crashText: string;
  onCrashText: (text: string) => void;
}) {
  const { t, num, target, guideNotes } = useTogetherText();

  const game = togetherGame(key),
    guide = togetherGameGuide(key);
  const prediction = key === 'blackjack' || key === 'virtual_football_3d';
  const crash = key === 'sky_crash' || key === 'crash_point';
  const race = key === 'thunder_derby_3d' || key === 'neon_hounds_3d';
  const pick = (n: number) => {
    if (disabled) return;
    onChange(
      game.picks === 1
        ? [n]
        : selected.includes(n)
          ? selected.filter((v) => v !== n)
          : selected.length < game.picks
            ? [...selected, n]
            : selected
    );
  };
  return (
    <div className="together-selection">
      <p className="together-choice-note">{t(guide.choiceNote)}</p>
      <ul className="together-rule-note">
        {guide.mechanics.map((line) => (
          <li key={line}>{t(line)}</li>
        ))}
      </ul>
      {game.picks === 0 ? (
        <p>{t('Every member confirms one equal entry. No selection is needed.')}</p>
      ) : prediction ? (
        <div className="together-predictions">
          {Array.from({ length: game.picks }, (_, i) => (
            <label key={i}>
              {key === 'blackjack'
                ? t('Hand {number} vs dealer', { number: i + 1 })
                : t('Simulated match {number}', { number: i + 1 })}
              {guideNotes(key)[i] && <small>{guideNotes(key)[i]}</small>}
              <select
                disabled={disabled}
                value={selected[i] ?? ''}
                onChange={(e) => {
                  const next = Array.from({ length: game.picks }, (_, j) => selected[j] ?? -1);
                  next[i] = Number(e.target.value);
                  onChange(next);
                }}
              >
                <option value="" disabled>
                  {t('Choose a prediction')}
                </option>
                {(key === 'blackjack'
                  ? [t('Win'), t('Draw'), t('Lose')]
                  : [t('Home win'), t('Draw'), t('Away win')]
                ).map((label, i) => (
                  <option key={i} value={i}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : crash ? (
        <>
          <label className="together-field">
            {t('Automatic exit target ({min}–{max})', { min: target(101), max: target(2000) })}
            <input
              inputMode="decimal"
              placeholder={num(2, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              disabled={disabled}
              value={
                disabled && selected.length
                  ? num(selected[0] / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  : crashText
              }
              onChange={(e) => {
                onCrashText(e.target.value);
                const m = /^(\d{1,2})(?:\.(\d{0,2}))?$/.exec(groupNumericInput(e.target.value));
                onChange(m ? [Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))] : []);
              }}
            />
            {selected[0] >= 101 && selected[0] <= 2000 && (
              <small>
                {t(
                  'Chance this target survives: {percent}%. Surviving does not guarantee winning the group contest.',
                  {
                    percent: num(togetherCrashSurvivalPercent(selected[0]), {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }),
                  }
                )}
              </small>
            )}
          </label>
          <div className="together-target-presets" aria-label={t('Target shortcuts')}>
            {[125, 150, 200, 300].map((n) => (
              <button
                type="button"
                key={n}
                disabled={disabled}
                aria-pressed={selected[0] === n}
                onClick={() => {
                  onCrashText(num(n / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
                  onChange([n]);
                }}
              >
                {target(n)}
              </button>
            ))}
          </div>
        </>
      ) : key === 'number_challenge' ? (
        <label className="together-field">
          {t('Your number ({min}–{max})', { min: 1, max: 100 })}
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            disabled={disabled}
            value={selected[0] ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? [] : [Number(e.target.value)])}
          />
        </label>
      ) : (
        <fieldset className="together-pick-fieldset" disabled={disabled}>
          <legend>
            {t('{label} · {count} of {total} selected', {
              label: t(guide.selectionLabel),
              count: selected.length,
              total: game.picks,
            })}
          </legend>
          <div className={race ? 'together-runner-grid' : 'together-number-grid'}>
            {Array.from({ length: game.max - game.min + 1 }, (_, i) => i + game.min).map((n) => (
              <button
                type="button"
                key={n}
                aria-label={
                  race
                    ? key === 'neon_hounds_3d'
                      ? t('Choose dog {number}', { number: n })
                      : t('Choose runner {number}', { number: n })
                    : t('Choose {number}', { number: n })
                }
                aria-pressed={selected.includes(n)}
                disabled={disabled}
                onClick={() => pick(n)}
              >
                {race ? (
                  <>
                    <span aria-hidden="true">{key === 'neon_hounds_3d' ? '🐕' : '🐎'}</span>
                    <strong>
                      {key === 'neon_hounds_3d'
                        ? t('Dog {number}', { number: n })
                        : t('Runner {number}', { number: n })}
                    </strong>
                    <small>{t('Equal chance')}</small>
                  </>
                ) : (
                  num(n)
                )}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <p className="together-rule-note">{t(guide.tieRule)}</p>
    </div>
  );
}
