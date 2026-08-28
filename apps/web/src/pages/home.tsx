import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useSocket } from '@/providers/socket-provider';

interface HealthResponse {
  success: boolean;
  data?: {
    name: string;
    version: string;
    status: string;
  };
}

export function HomePage() {
  const { user } = useAuth();
  const { isConnected } = useSocket();

  const { data: health, isLoading: healthLoading } = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await api.get<HealthResponse['data']>('/health');
      return res;
    },
  });

  return (
    <div className="space-y-8">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
          Welcome to SocialPlay
        </h2>
        <p className="text-gray-600 dark:text-gray-400">
          {user
            ? `You're signed in as ${user.displayName || user.username}.`
            : 'Sign in to get started.'}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">
            System Status
          </h3>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600 dark:text-gray-300">API Server</span>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              health?.data?.status === 'running'
                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                : healthLoading
                  ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                  : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
            }`}>
              {healthLoading ? 'Checking...' : health?.data?.status || 'Offline'}
            </span>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4">
            Realtime Connection
          </h3>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600 dark:text-gray-300">Socket</span>
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              isConnected
                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
            }`}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}