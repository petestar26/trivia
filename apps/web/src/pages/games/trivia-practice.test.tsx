import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TriviaPracticePage } from './trivia-practice';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  user: { id: 'member' } as { id: string } | null,
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  api: { get: mocks.get, post: mocks.post },
}));
const bank = [
  {
    id: 'q1',
    question: 'What is 2 + 2?',
    choices: ['3', '4', '5'],
    category: 'Math',
    difficulty: 1,
  },
  {
    id: 'q2',
    question: 'Which planet is closest to the Sun?',
    choices: ['Earth', 'Mercury'],
    category: 'Science',
    difficulty: 1,
  },
];
const ok = (data: unknown) => ({ success: true, data });
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
        })
      }
    >
      <MemoryRouter>
        <TriviaPracticePage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  mocks.user = { id: 'member' };
  mocks.get.mockResolvedValue(ok({ questions: bank, mode: 'practice', rewards: false }));
  mocks.post.mockImplementation(
    async (_path: string, body: { questionId: string; answerIndex: number }) =>
      ok({
        ...body,
        correctIndex: 1,
        correct: body.answerIndex === 1,
        mode: 'practice',
        rewards: false,
      })
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('clearly labels practice and only reads the separate question endpoint', async () => {
  mount();
  await screen.findByRole('heading', { name: bank[0].question });
  expect(screen.getByRole('heading', { name: 'Trivia practice' })).toBeInTheDocument();
  expect(screen.getByText(/No Coins, Game Points, rewards or cash prizes/)).toBeInTheDocument();
  expect(screen.getByText(/not saved after leaving or reloading/)).toBeInTheDocument();
  expect(mocks.get).toHaveBeenCalledWith('/games/trivia-practice/questions');
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Check answer' })).toBeDisabled();
  expect(screen.queryByText('Correct answer: 4')).not.toBeInTheDocument();
});
it.each([
  ['4', 'Correct!'],
  ['3', 'Not quite.'],
])(
  'shows the server-confirmed result for %s without any reward request',
  async (choice, message) => {
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: choice }));
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText('Correct answer: 4')).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith('/games/trivia-practice/answers', {
      questionId: 'q1',
      answerIndex: choice === '4' ? 1 : 0,
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: choice })).toBeDisabled();
  }
);
it('moves to the next question and clears the previous selection and result', async () => {
  mount();
  fireEvent.click(await screen.findByRole('radio', { name: '4' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
  await screen.findByText('Correct!');
  fireEvent.click(screen.getByRole('button', { name: 'Next question' }));
  expect(screen.getByRole('heading', { name: bank[1].question })).toBeInTheDocument();
  expect(screen.queryByText('Correct!')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check answer' })).toBeDisabled();
  expect(screen.getByRole('radio', { name: 'Mercury' })).not.toBeChecked();
});
it('does not invent a result after a failed or inconsistent answer response', async () => {
  mocks.post.mockResolvedValue(
    ok({
      questionId: 'q1',
      answerIndex: 1,
      correctIndex: 0,
      correct: true,
      mode: 'practice',
      rewards: false,
    })
  );
  mount();
  fireEvent.click(await screen.findByRole('radio', { name: '4' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Correct!')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check answer' })).toBeEnabled();
});
it('offers Retry when the bank is unavailable', async () => {
  mocks.get.mockRejectedValueOnce(new Error('Unavailable'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  await screen.findByRole('heading', { name: bank[0].question });
  expect(mocks.get).toHaveBeenCalledTimes(2);
});
it('does not request data when signed out', () => {
  mocks.user = null;
  mount();
  expect(screen.getByText('Sign in to practise Trivia.')).toBeInTheDocument();
  expect(mocks.get).not.toHaveBeenCalled();
});
it('shows an honest empty state when no active practice questions exist', async () => {
  mocks.get.mockResolvedValue(ok({ questions: [], mode: 'practice', rewards: false }));
  mount();
  expect(
    await screen.findByText('No practice questions are available right now.')
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check answer' })).not.toBeInTheDocument();
});
it('starts fresh after remounting instead of claiming a persisted score', async () => {
  const first = mount();
  fireEvent.click(await screen.findByRole('radio', { name: '4' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
  await screen.findByText('Correct!');
  first.unmount();
  mount();
  await screen.findByRole('heading', { name: bank[0].question });
  await waitFor(() => expect(screen.queryByText('Correct!')).not.toBeInTheDocument());
  expect(screen.getByRole('radio', { name: '4' })).not.toBeChecked();
});
