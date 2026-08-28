# SocialPlay

A web-first social platform with groups, chat, voice messages, virtual economy, and mini-games.

## Tech Stack

### Frontend
- **React 18** + TypeScript
- **Vite 5** for build/dev
- **React Router v6** for routing
- **TanStack Query** for server state
- **Zustand** for client state
- **Radix UI** + **Tailwind CSS** for components
- **React Hook Form** + **Zod** for forms
- **Socket.IO Client** for realtime
- **PWA** via vite-plugin-pwa

### Backend
- **Node.js 20+** + TypeScript
- **Fastify 4** for API
- **Socket.IO 4** for realtime
- **Prisma 5** + **PostgreSQL** for database
- **JWT** (access + refresh tokens) in HttpOnly cookies
- **Zod** for validation (shared with frontend)
- **Pino** for logging

### Shared
- **Types**, **Enums**, **Constants**, **Validation schemas** (Zod)

### Infrastructure
- **pnpm workspaces** for monorepo
- **ESLint** + **Prettier** for code quality
- **Vitest** for testing
- **Docker** (planned) for deployment

## Project Structure

```
socialplay/
├── apps/
│   ├── web/          # Frontend application
│   └── api/          # Backend API
├── packages/
│   ├── database/     # Prisma client & schema
│   ├── shared/       # Shared types, constants, validation
│   ├── config/       # Environment config (Zod)
│   └── storage/      # File storage abstraction
├── docs/             # Documentation
└── infrastructure/   # Docker, CI/CD (future)
```

## Quick Start

### Prerequisites
- Node.js 20+
- pnpm 8.15+
- PostgreSQL 15+
- Redis 7+ (optional, for Socket.IO scaling)

### Installation

```bash
# Clone and enter directory
cd ~/Desktop/Game

# Install dependencies
pnpm install

# Copy environment file
cp .env.example .env.local

# Edit .env.local with your database URL and secrets
# DATABASE_URL=postgresql://user:pass@localhost:5432/socialplay
# JWT_ACCESS_SECRET=your-32-char-secret
# JWT_REFRESH_SECRET=your-32-char-secret

# Generate Prisma client
pnpm db:generate

# Push schema to database
pnpm db:push

# Start development servers
pnpm dev
```

### Development

```bash
# Run all dev servers (frontend + backend)
pnpm dev

# Frontend only (port 5173)
pnpm --filter web dev

# Backend only (port 3000)
pnpm --filter api dev

# Type check all packages
pnpm typecheck

# Lint all packages
pnpm lint

# Format code
pnpm format

# Run tests
pnpm test
```

### Database Commands

```bash
# Generate Prisma client
pnpm db:generate

# Push schema changes (dev)
pnpm db:push

# Create migration
pnpm db:migrate

# Deploy migrations (production)
pnpm db:migrate:deploy

# Open Prisma Studio
pnpm db:studio

# Seed database
pnpm db:seed
```

### Build

```bash
# Build all packages
pnpm build

# Frontend build output: apps/web/dist/
# Backend build output: apps/api/dist/
```

## Environment Variables

See `.env.example` for all available options.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | Yes | Access token secret (32+ chars) |
| `JWT_REFRESH_SECRET` | Yes | Refresh token secret (32+ chars) |
| `CORS_ORIGIN` | Yes | Frontend URL for CORS |
| `STORAGE_PROVIDER` | No | `local`, `s3`, `r2`, `minio` |
| `REDIS_URL` | No | Redis for Socket.IO scaling |

## API Endpoints

### Health
- `GET /health` - Basic health check
- `GET /health?detailed` - Detailed health info

### Auth
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/refresh` - Refresh access token
- `POST /api/v1/auth/logout` - Logout
- `GET /api/v1/auth/me` - Get current user

## WebSocket

Connect to `ws://localhost:3000/ws` with JWT in handshake auth.

```javascript
const socket = io('http://localhost:3000', {
  path: '/ws',
  auth: { token: 'access_token' },
  withCredentials: true,
});
```

## PWA

The frontend is configured as a PWA with:
- Web App Manifest
- Service Worker (Workbox)
- Offline caching
- Installable on mobile/desktop

## Documentation

- [Architecture](docs/architecture.md) - Detailed architecture overview

## License

MIT