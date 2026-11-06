import { Link } from 'react-router-dom';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function LuckySpinPage() {
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <div className="text-5xl">🎡</div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
        {translateUi('Lucky Spin')}
      </h1>
      <p className="text-gray-600 dark:text-gray-400">
        {translateUi('This game is no longer available.')}
      </p>
      <Link
        to="/games"
        className="inline-block px-6 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700"
      >
        {translateUi('Back to Games')}
      </Link>
    </div>
  );
}
