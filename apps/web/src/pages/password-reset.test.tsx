import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { PasswordResetPage } from './password-reset';
const post = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { post }, unwrapData: (r: { data: unknown }) => r.data }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});
function show(token = 'test-one-use-token') {
  window.history.replaceState(null, '', `/reset-password${token ? '#token=' + token : ''}`);
  return render(
    <MemoryRouter>
      <PasswordResetPage />
    </MemoryRouter>
  );
}
it('keeps the reset credential out of the address bar and visible page', () => {
  show();
  expect(window.location.hash).toBe('');
  expect(document.body.textContent).not.toContain('test-one-use-token');
  expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'password');
});
it('requires a recovery link and matching strong passwords', () => {
  show('');
  expect(screen.getByRole('alert')).toHaveTextContent('Open your current recovery link');
  expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
});
it('resets once through the server and offers sign in without retaining the password', async () => {
  post.mockResolvedValue({ data: { reset: true } });
  show();
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: 'New-Private-Password-44!' },
  });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: 'Different-Password-55!' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
  expect(screen.getByRole('alert')).toHaveTextContent('must match');
  expect(post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: 'New-Private-Password-44!' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
  expect(
    await screen.findByRole('heading', { name: 'Your password is ready' })
  ).toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /administrator sign in/ })).toHaveAttribute(
    'href',
    '/admin/login'
  );
});
it('shows expired-link failure without claiming a successful password change', async () => {
  post.mockRejectedValue(new Error('This reset link is expired.'));
  show();
  for (const label of ['New password', 'Confirm new password'])
    fireEvent.change(screen.getByLabelText(label), {
      target: { value: 'New-Private-Password-44!' },
    });
  fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('expired');
  expect(screen.queryByText('Your password is ready')).not.toBeInTheDocument();
});
