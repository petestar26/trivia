import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { SocketProvider } from './socket-provider';
import { VoiceMessagePlayer } from '../components/voice/voice-message-player';

vi.mock('@/lib/api-config', () => ({
  API_ORIGIN: 'https://api.example.com',
  API_BASE: 'https://api.example.com/api/v1',
}));
vi.mock('./auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() })),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('connects Socket.IO to the API origin with credentials and the root /ws path', () => {
  render(<SocketProvider><div /></SocketProvider>);
  expect(io).toHaveBeenCalledWith('https://api.example.com', expect.objectContaining({
    path: '/ws', withCredentials: true,
  }));
});

it('loads authenticated voice messages from the API with CORS credentials', () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const { container } = render(<VoiceMessagePlayer groupId="group" messageId="message" />);
  const audio = container.querySelector('audio');
  expect(audio).toHaveAttribute('src', 'https://api.example.com/api/v1/groups/group/voice-messages/message');
  expect(audio).toHaveAttribute('crossorigin', 'use-credentials');
});
