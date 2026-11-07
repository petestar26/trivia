import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function DiceFace({ value, hidden = false }: { value: number; hidden?: boolean }) {
  const { t: translateUi } = useInterfaceLanguage();

  const pips: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  return (
    <div
      className="system-die"
      role="img"
      aria-label={
        hidden ? translateUi('Dice awaiting result') : translateUi('Die {value}', { value: value })
      }
    >
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={!hidden && pips[value]?.includes(i) ? 'pip' : 'empty'} />
      ))}
    </div>
  );
}
