import { useId } from 'react';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function parseSpinStake(value: string, maximum: number): number {
  if (!/^\d+$/.test(value)) return 0;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 40 && amount <= maximum && amount % 40 === 0
    ? amount
    : 0;
}

export function SpinStakeInput({
  value,
  onChange,
  maximum,
  disabled,
  currency = 'practice credits',
}: {
  value: string;
  onChange: (value: string) => void;
  maximum: number;
  disabled: boolean;
  currency?: string;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  const id = useId();
  const valid = !!parseSpinStake(value, maximum);
  return (
    <div className="rounded-xl border border-amber-200/25 bg-black/20 p-4">
      <label htmlFor={id} className="block text-sm font-semibold text-amber-100">
        {translateUi('Bet amount')}
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-invalid={!valid}
          aria-describedby={`${id}-help`}
          className="h-12 w-40 max-w-full rounded-lg border border-amber-200/40 bg-[#07281f] px-3 text-lg font-bold text-white focus:outline-none focus:ring-2 focus:ring-amber-200 disabled:opacity-50"
        />
        <span className="text-sm text-emerald-100/80">
          {translateUi('{currency} per selection', { currency: currency })}
        </span>
      </div>
      <p
        id={`${id}-help`}
        className={`mt-2 text-xs ${valid ? 'text-emerald-100/70' : 'text-amber-200'}`}
      >
        {valid
          ? translateUi('Each tap adds this amount. Changing it applies to new selections only.')
          : translateUi('Enter a whole amount from 40 to {value} in steps of 40.', {
              value: Math.max(0, Math.floor(maximum / 40) * 40),
            })}
      </p>
    </div>
  );
}
