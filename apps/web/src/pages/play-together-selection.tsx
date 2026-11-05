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
      <p className="together-choice-note">{guide.choiceNote}</p>
      <ul className="together-rule-note">
        {guide.mechanics.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {game.picks === 0 ? (
        <p>Every member confirms one equal entry. No selection is needed.</p>
      ) : prediction ? (
        <div className="together-predictions">
          {Array.from({ length: game.picks }, (_, i) => (
            <label key={i}>
              {key === 'blackjack' ? `Hand ${i + 1} vs dealer` : `Simulated match ${i + 1}`}
              {guide.fixtureNotes?.[i] && <small>{guide.fixtureNotes[i]}</small>}
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
                  Choose a prediction
                </option>
                {(key === 'blackjack'
                  ? ['Win', 'Draw', 'Lose']
                  : ['Home win', 'Draw', 'Away win']
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
            Automatic exit target (1.01×–20×)
            <input
              inputMode="decimal"
              placeholder="2.00"
              disabled={disabled}
              value={disabled && selected.length ? (selected[0] / 100).toFixed(2) : crashText}
              onChange={(e) => {
                onCrashText(e.target.value);
                const m = /^(\d{1,2})(?:\.(\d{0,2}))?$/.exec(e.target.value);
                onChange(m ? [Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))] : []);
              }}
            />
            {selected[0] >= 101 && selected[0] <= 2000 && (
              <small>
                Chance this target survives: {togetherCrashSurvivalPercent(selected[0]).toFixed(2)}
                %. Surviving does not guarantee winning the group contest.
              </small>
            )}
          </label>
          <div className="together-target-presets" aria-label="Target shortcuts">
            {[125, 150, 200, 300].map((n) => (
              <button
                type="button"
                key={n}
                disabled={disabled}
                aria-pressed={selected[0] === n}
                onClick={() => {
                  onCrashText((n / 100).toFixed(2));
                  onChange([n]);
                }}
              >
                {(n / 100).toFixed(2)}×
              </button>
            ))}
          </div>
        </>
      ) : key === 'number_challenge' ? (
        <label className="together-field">
          Your number (1–100)
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
            {guide.selectionLabel} · {selected.length} of {game.picks} selected
          </legend>
          <div className={race ? 'together-runner-grid' : 'together-number-grid'}>
            {Array.from({ length: game.max - game.min + 1 }, (_, i) => i + game.min).map((n) => (
              <button
                type="button"
                key={n}
                aria-label={
                  (race
                    ? key === 'neon_hounds_3d'
                      ? 'Choose dog '
                      : 'Choose runner '
                    : 'Choose ') + n
                }
                aria-pressed={selected.includes(n)}
                disabled={disabled}
                onClick={() => pick(n)}
              >
                {race ? (
                  <>
                    <span aria-hidden="true">{key === 'neon_hounds_3d' ? '🐕' : '🐎'}</span>
                    <strong>
                      {key === 'neon_hounds_3d' ? 'Dog' : 'Runner'} {n}
                    </strong>
                    <small>Equal chance</small>
                  </>
                ) : (
                  n
                )}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <p className="together-rule-note">{guide.tieRule}</p>
    </div>
  );
}
