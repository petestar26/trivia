import { GoogleSignInButton } from '@/components/google-sign-in-button';
import { useMemberTheme } from '@/components/member/use-member-theme';
import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { phoneSchema } from '@socialplay/shared';
import { useAuth } from '@/providers/auth-provider';
import { getErrorMessage } from '@/lib/error-message';
import { safeReturnTo } from '@/lib/safe-return-to';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MemberAuthShell } from '@/components/member/member-auth-shell';
import { PasswordInput } from '@/components/member/password-input';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

export function LoginPage({ workspace }: { workspace?: 'admin' | 'agent' }) {
  useMemberTheme(!workspace);
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [method, setMethod] = useState<'email' | 'phone'>('email');

  // Where to go after signing in: the location ProtectedRoute turned the
  // visitor away from — path, query string and fragment — if it is a plain
  // in-app location, otherwise the home page. See safe-return-to.ts.
  const returnTo = safeReturnTo((location.state as { from?: unknown } | null)?.from);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(method === 'phone' ? loginSchema.extend({ email: phoneSchema }) : loginSchema),
  });

  const onSubmit = async (data: LoginForm) => {
    setError(null);
    setIsLoading(true);
    try {
      if (method === 'phone') await login(data.email, data.password, 'phone');
      else await login(data.email, data.password);
      // Replace, so the sign-in page does not stay behind as a Back target.
      navigate(workspace && !returnTo.startsWith(`/${workspace}/`) ? `/${workspace}` : returnTo, {
        replace: true,
      });
    } catch (err) {
      setError(getErrorMessage(err, 'Login failed'));
    } finally {
      setIsLoading(false);
    }
  };

  const form = (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold text-gray-900 dark:text-white">
          {workspace === 'admin'
            ? 'Administrator sign in'
            : workspace === 'agent'
              ? 'Agent sign in'
              : 'Welcome back'}
        </CardTitle>
        <CardDescription className="text-gray-600 dark:text-gray-400">
          {workspace
            ? `Sign in with your approved ${workspace === 'admin' ? 'administrator' : 'agent'} account`
            : 'Sign in to your Salem Bet account'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!workspace && <GoogleSignInButton onSuccess={() => navigate(returnTo, { replace: true })} />}
        {!workspace && <div role="group" aria-label="Sign-in method" className="flex gap-2">
          {(['email', 'phone'] as const).map(option => <Button key={option} type="button" disabled={isLoading}
            aria-pressed={method === option} onClick={() => { setMethod(option); reset(); setError(null); }}>
            {option === 'email' ? 'Email' : 'Phone'}</Button>)}
        </div>}
        {error && (
          <div
            role="alert"
            className="text-red-600 dark:text-red-400 text-sm text-center bg-red-50 dark:bg-red-900/30 p-3 rounded-lg"
          >
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {method === 'email' ? 'Email' : 'Phone number'}
            </label>
            <Input
              id="email"
              type={method === 'email' ? 'email' : 'tel'}
              placeholder={method === 'email' ? 'you@example.com' : '+251911234567'}
              autoComplete="username"
              {...register('email')}
              disabled={isLoading}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'login-email-error' : undefined}
            />
            {errors.email && (
              <p
                id="login-email-error"
                className="text-sm text-red-600 dark:text-red-400"
                role="alert"
              >
                {errors.email.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label
              htmlFor="password"
              className="text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Password
            </label>
            {workspace ? (
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                {...register('password')}
                disabled={isLoading}
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'login-password-error' : undefined}
              />
            ) : (
              <PasswordInput
                id="password"
                autoComplete="current-password"
                placeholder="••••••••"
                {...register('password')}
                disabled={isLoading}
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'login-password-error' : undefined}
              />
            )}
            {errors.password && (
              <p
                id="login-password-error"
                className="text-sm text-red-600 dark:text-red-400"
                role="alert"
              >
                {errors.password.message}
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex flex-col justify-center">
        {workspace ? (
          <div className="text-center text-sm space-y-3">
            <p>
              Access is assigned by the platform. Signing in here does not change your permissions.
            </p>
            {workspace === 'agent' && (
              <p>
                <Link to="/agent/activate" className="text-primary-600">
                  First sign-in? Set your private password
                </Link>
              </p>
            )}
            <Link to="/login" className="text-primary-600">
              Member sign in
            </Link>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Don't have an account?{' '}
              <Link
                to="/register"
                state={{ from: (location.state as { from?: unknown } | null)?.from }}
                className="text-primary-600 hover:text-primary-500 font-medium"
              >
                Sign up
              </Link>
            </p>
          </>
        )}
      </CardFooter>
    </Card>
  );

  return workspace ? (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      {form}
    </div>
  ) : (
    <MemberAuthShell mode="login">{form}</MemberAuthShell>
  );
}
