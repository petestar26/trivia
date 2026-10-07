import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './auth-provider';
import { renewSession, sessionRevision } from '@/lib/session';
import { API_BASE, API_ORIGIN } from '@/lib/api-config';

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      setIsConnected(false);
      return;
    }

    const newSocket = io(API_ORIGIN || '/', {
      path: '/ws',
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });

    let disposed = false;
    let recoveryUsed = false;
    const recoverSession = async () => {
      // One attempt per lost connection. A rejected account/handshake must
      // not create an unbounded refresh-and-reconnect loop.
      if (disposed || recoveryUsed) return;
      recoveryUsed = true;
      try {
        await renewSession(API_BASE, sessionRevision());
        if (!disposed) newSocket.connect();
      } catch {
        /* Keep disconnected; explicit sign-in or reload can retry. */
      }
    };
    newSocket.on('connect', () => {
      recoveryUsed = false;
      setIsConnected(true);
    });
    newSocket.on('disconnect', (reason) => {
      setIsConnected(false);
      if (reason === 'io server disconnect') void recoverSession();
    });
    newSocket.on('connect_error', (error) => {
      setIsConnected(false);
      if (error.message === 'UNAUTHORIZED') void recoverSession();
    });

    setSocket(newSocket);

    return () => {
      disposed = true;
      newSocket.removeAllListeners();
      newSocket.disconnect();
      setSocket(null);
      setIsConnected(false);
    };
  }, [isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps
  // NOTE: `socket` is intentionally omitted from the dep array here; it is
  // derived state from this same effect. Including it would cause a loop.

  return (
    <SocketContext.Provider value={{ socket, isConnected }}>{children}</SocketContext.Provider>
  );
}

export function useSocket() {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
