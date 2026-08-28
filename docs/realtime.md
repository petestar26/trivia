# SocialPlay Realtime Architecture

## Overview

SocialPlay uses Socket.IO for realtime communication, enabling instant message delivery, typing indicators, presence updates, and notifications.

## Technology Stack

- **Socket.IO 4** - WebSocket with fallback
- **Redis Adapter** - For horizontal scaling
- **JWT Authentication** - Secure handshake
- **Namespace-based routing** - Organized event handling

## Connection Architecture

### Client Connection
```typescript
import { io } from 'socket.io-client';

const socket = io(API_URL, {
  path: '/ws',
  auth: {
    token: accessToken
  },
  withCredentials: true,
  transports: ['websocket', 'polling']
});
```

### Server Setup
```typescript
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';

const io = new Server(fastify.server, {
  path: '/ws',
  cors: {
    origin: config.CORS_ORIGIN,
    credentials: true
  }
});

// Redis adapter for scaling
if (config.REDIS_URL) {
  const pubClient = createClient({ url: config.REDIS_URL });
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));
}
```

## Authentication

### Handshake Authentication
```typescript
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    return next(new Error('Authentication required'));
  }
  
  try {
    const payload = await verifyJwtToken(token);
    socket.data.userId = payload.sub;
    socket.data.user = payload;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});
```

## Room Management

### Room Naming Convention
- User room: `user:${userId}`
- Group room: `group:${groupId}`
- Admin room: `admin:${role}`

### Joining Rooms
```typescript
// On connection, join user's personal room
socket.on('connect', () => {
  socket.join(`user:${socket.data.userId}`);
});

// Join group when opening group chat
socket.on('join_room', (roomId: string) => {
  // Verify user has access to room
  if (canAccessRoom(socket.data.userId, roomId)) {
    socket.join(roomId);
    socket.emit('room_joined', { roomId });
  }
});

// Leave group when closing group chat
socket.on('leave_room', (roomId: string) => {
  socket.leave(roomId);
  socket.emit('room_left', { roomId });
});
```

## Events

### Client → Server Events

| Event | Description | Payload |
|-------|-------------|---------|
| `join_room` | Join a room | `{ roomId: string }` |
| `leave_room` | Leave a room | `{ roomId: string }` |
| `typing_start` | Start typing indicator | `{ groupId: string }` |
| `typing_stop` | Stop typing indicator | `{ groupId: string }` |
| `mark_read` | Mark messages as read | `{ groupId: string, messageId: string }` |

### Server → Client Events

| Event | Description | Payload |
|-------|-------------|---------|
| `message:created` | New message | `MessageBasicInfo` |
| `message:updated` | Message edited | `MessageBasicInfo` |
| `message:deleted` | Message deleted | `{ messageId: string }` |
| `message:reaction` | Reaction added/removed | `{ messageId, userId, type }` |
| `typing:start` | User started typing | `{ groupId, userId, username }` |
| `typing:stop` | User stopped typing | `{ groupId, userId }` |
| `notification` | New notification | `NotificationInfo` |
| `presence:update` | User presence change | `{ userId, status }` |
| `gift:received` | Gift received | `GiftTransactionInfo` |

### Server → Room Events

```typescript
// Broadcast new message to group
io.to(`group:${groupId}`).emit('message:created', message);

// Send notification to specific user
io.to(`user:${userId}`).emit('notification', notification);

// Broadcast to all admins
io.to('admin:moderator').emit('report:new', report);
```

## Event Handlers

### Message Events
```typescript
// After message is created via REST API
async function broadcastMessage(message: Message) {
  io.to(`group:${message.groupId}`).emit('message:created', {
    id: message.id,
    groupId: message.groupId,
    userId: message.userId,
    content: message.content,
    type: message.type,
    createdAt: message.createdAt
  });
}
```

### Typing Indicators
```typescript
socket.on('typing_start', ({ groupId }) => {
  socket.to(`group:${groupId}`).emit('typing:start', {
    groupId,
    userId: socket.data.userId,
    username: socket.data.user.username
  });
});

socket.on('typing_stop', ({ groupId }) => {
  socket.to(`group:${groupId}`).emit('typing:stop', {
    groupId,
    userId: socket.data.userId
  });
});
```

### Presence
```typescript
// Track online users
const onlineUsers = new Map<string, Set<string>>();

socket.on('connect', () => {
  const userId = socket.data.userId;
  
  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId)!.add(socket.id);
  
  // Broadcast presence update
  io.emit('presence:update', { userId, status: 'online' });
});

socket.on('disconnect', () => {
  const userId = socket.data.userId;
  const userSockets = onlineUsers.get(userId);
  
  if (userSockets) {
    userSockets.delete(socket.id);
    
    if (userSockets.size === 0) {
      onlineUsers.delete(userId);
      io.emit('presence:update', { userId, status: 'offline' });
    }
  }
});
```

## Notification System

### Notification Flow
```typescript
async function sendNotification(userId: string, notification: NotificationInfo) {
  // Store in database
  await prisma.notification.create({
    data: notification
  });
  
  // Push via WebSocket if online
  io.to(`user:${userId}`).emit('notification', notification);
  
  // Optional: Push notification (PWA)
  if (notification.channels.includes('push')) {
    await sendPushNotification(userId, notification);
  }
}
```

### Notification Types
- Message received
- Mention in message
- Reaction to message
- Gift received
- Group invite
- Friend request
- Achievement unlocked
- VIP expiring
- System announcements

## Error Handling

### Connection Errors
```typescript
socket.on('connect_error', (err) => {
  console.error('Connection error:', err.message);
  
  if (err.message === 'Invalid token') {
    // Redirect to login
    window.location.href = '/login';
  }
});
```

### Reconnection
```typescript
const socket = io(API_URL, {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});

socket.on('reconnect', (attempt) => {
  console.log('Reconnected after', attempt, 'attempts');
});

socket.on('reconnect_failed', () => {
  console.error('Failed to reconnect');
  // Show offline banner
});
```

## Rate Limiting

### Event Rate Limits
```typescript
import { RateLimiterMemory } from 'rate-limiter-flexible';

const limiter = new RateLimiterMemory({
  points: 10, // 10 events
  duration: 1, // per second
});

io.use(async (socket, next) => {
  try {
    await limiter.consume(socket.data.userId);
    next();
  } catch {
    next(new Error('Rate limit exceeded'));
  }
});
```

### Per-Event Limits
- `typing_start/stop`: 5 per second
- `message:create`: 10 per minute (REST API)
- `join_room`: 10 per second

## Scaling

### Redis Adapter
Required when running multiple API instances:
```typescript
import { createAdapter } from '@socket.io/redis-adapter';

const pubClient = createClient({ url: config.REDIS_URL });
const subClient = pubClient.duplicate();

io.adapter(createAdapter(pubClient, subClient));
```

### Sticky Sessions
When using load balancer, configure sticky sessions based on `io` cookie or IP hash.

## Monitoring

### Connection Metrics
- Total connections
- Connections per user
- Events per minute
- Error rate
- Average latency

### Health Check
```typescript
fastify.get('/health/realtime', async (req, reply) => {
  return {
    status: 'healthy',
    connections: io.sockets.sockets.size,
    rooms: io.sockets.adapter.rooms.size
  };
});
```

## Security

### Namespaces
Use namespaces for different access levels:
```typescript
const mainNs = io.of('/');
const adminNs = io.of('/admin');

adminNs.use(async (socket, next) => {
  if (!socket.data.user.roles.includes('admin')) {
    return next(new Error('Admin access required'));
  }
  next();
});
```

### Room Access Control
Always verify user has permission before joining room:
```typescript
socket.on('join_room', async (roomId) => {
  const hasAccess = await checkRoomAccess(socket.data.userId, roomId);
  if (!hasAccess) {
    return socket.emit('error', { message: 'Access denied' });
  }
  socket.join(roomId);
});
```

## Future Enhancements

### Phase 2
- Message delivery receipts
- Read receipts per user
- Presence with last seen
- Voice message streaming

### Phase 3
- WebRTC for voice calls
- Live streaming support
- Screen sharing
- Real-time collaboration
