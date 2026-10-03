import type { GiftTheme } from '@socialplay/shared';
const themes: Record<GiftTheme, string> = {
  rose: 'from-rose-50 via-pink-100 to-rose-200', amber: 'from-amber-50 via-yellow-100 to-orange-200',
  violet: 'from-violet-50 via-purple-100 to-fuchsia-200', sky: 'from-sky-50 via-cyan-100 to-blue-200',
  emerald: 'from-emerald-50 via-green-100 to-teal-200', indigo: 'from-indigo-50 via-blue-100 to-violet-200',
};
export function GiftArt({ emoji, theme, small = false }: { emoji: string; theme: GiftTheme; small?: boolean }) {
  return <div aria-hidden="true" className={`relative flex items-center justify-center overflow-hidden bg-gradient-to-br ${themes[theme] ?? themes.violet} ${small ? 'h-20 w-20 shrink-0 rounded-2xl' : 'h-36 rounded-2xl'}`}>
    <span className="absolute right-4 top-3 text-lg text-white">✦</span>
    <span className={`${small ? 'text-4xl' : 'text-6xl'} drop-shadow-lg transition-transform duration-200 motion-safe:group-hover:scale-110`}>{emoji}</span>
    <span className="absolute bottom-3 left-4 text-xs text-white">✧</span>
  </div>;
}
