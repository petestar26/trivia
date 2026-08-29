import { useAuth } from '@/providers/auth-provider';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function ProfilePage() {
  const { user, logout } = useAuth();

  if (!user) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <Card><CardContent className="py-8 text-center text-gray-500 dark:text-gray-400">Not signed in.</CardContent></Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Profile</h1>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center">
              <span className="text-2xl font-bold text-primary-600 dark:text-primary-400">
                {user.displayName?.[0]?.toUpperCase() || user.username?.[0]?.toUpperCase() || 'U'}
              </span>
            </div>
            <div>
              <CardTitle className="text-xl">{user.displayName || user.username}</CardTitle>
              <p className="text-sm text-gray-500 dark:text-gray-400">@{user.username}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {user.bio && <p className="text-sm text-gray-600 dark:text-gray-400">{user.bio}</p>}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500 dark:text-gray-400">Email</p>
              <p className="font-medium text-gray-900 dark:text-white">{user.email}</p>
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400">Joined</p>
              <p className="font-medium text-gray-900 dark:text-white">{new Date(user.createdAt).toLocaleDateString()}</p>
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400">Verified</p>
              <p className="font-medium">{user.isVerified ? '✓ Yes' : 'No'}</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => logout()} className="mt-4">
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
