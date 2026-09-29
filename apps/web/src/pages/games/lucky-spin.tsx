import { Link } from 'react-router-dom';

export function LuckySpinPage() {
  return (
    <div className="max-w-md mx-auto text-center py-16 space-y-4">
      <div className="text-5xl">🎡</div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Lucky Spin</h1>
      <p className="text-gray-600 dark:text-gray-400">This game is no longer available.</p>
      <Link
        to="/games"
        className="inline-block px-6 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700"
      >
        Back to Games
      </Link>
    </div>
  );
}