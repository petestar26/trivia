# SocialPlay Architecture

## Project Structure

```
socialplay/
├── apps/
│   ├── web/              # Frontend (React + TypeScript + Vite)
│   └── api/              # Backend (Fastify + TypeScript + Socket.IO)
├── packages/
│   ├── database/         # Prisma ORM + PostgreSQL
│   ├── shared/           # Shared types, constants, validation schemas
│   ├── config/           # Environment configuration (Zod)
│   └── storage/          # File storage abstraction
├── docs/                 # Documentation
├── infrastructure/       # Docker, CI/CD, deployment configs
└── turbo.json           # Turborepo config (optional)
```

## Frontend Architecture

### Technology Stack
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite 5
- **Routing**: React Router v6
- **State Management**: 
  - TanStack Query (server state)
  - Zustand (client state)
- **UI Components**: Radix UI primitives + Tailwind CSS
- **Forms**: React Hook Form + Zod validation
- **Realtime**: Socket.IO client
- **PWA**: vite-plugin-pwa

### Project Structure (web)
```
apps/web/
├── src/
│   ├── components/
│   │   ├── ui/           # Reusable UI components (Button, Input, Card, etc.)
│   │   ├── layout/       # Layout components (Sidebar, Header, Layout)
│   │   └── auth/         # Auth-related components (ProtectedRoute)
│   ├── pages/            # Page components
│   ├── providers/        # Context providers (Auth, Socket)
│   ├── hooks/            # Custom React hooks
│   ├── lib/              # Utilities, API client
│   ├── store/            # Zustand stores
│   ├── styles/           # Global styles, Tailwind imports
│   └── test/             # Test setup
├── public/               # Static assets, PWA icons
├── index.html
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

### Key Patterns
- **API Client**: Centralized `api.ts` with typed methods
- **Authentication**: Context-based with JWT in HttpOnly cookies
- **Realtime**: Socket.IO connection managed by provider
- **Forms**: React Hook Form with Zod resolvers
- **Error Handling**: Toast notifications for user-facing errors

## Backend Architecture

### Technology Stack
- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: Fastify 4
- **Database**: PostgreSQL with Prisma ORM
- **Realtime**: Socket.IO 4
- **Auth**: JWT (access + refresh tokens) in HttpOnly cookies
- **Validation**: Zod schemas (shared with frontend)
- **Logging**: Pino
- **Security**: Helmet, CORS, Rate limiting

### Project Structure (api)
```
apps/api/
├── src/
│   ├── server.ts         # Entry point
│   ├── routes/           # Route handlers
│   │   ├── health.ts
│   │   └── auth.ts
│   ├── middleware/
│   │   ├── error-handler.ts
│   │   ├── request-logger.ts
│   │   ├── auth.ts
│   │   └── validation.ts
│   ├── plugins/          # Fastify plugins
│   ├── ws/               # Socket.IO handlers
│   ├── services/         # Business logic
│   └── utils/            # Utilities
├── tsconfig.json
└── package.json
```

### Key Patterns
- **Error Handling**: Centralized error handler with consistent responses
- **Validation**: Zod schemas for body, query, params
- **Auth Middleware**: JWT verification with role-based access
- **Rate Limiting**: Global + auth-specific limits
- **Database**: Prisma client singleton with connection pooling

## Database Architecture

### Technology Stack
- **Database**: PostgreSQL 15+
- **ORM**: Prisma 5
- **Migrations**: Prisma Migrate

### Current Schema
```
models:
  - User
  - Session
  - AuditLog

enums:
  - UserStatus
  - UserRole
```

### Design Principles
- **Server-authoritative**: All financial/virtual economy operations on backend
- **Transactional**: Use Prisma transactions for multi-table operations
- **Audit Trail**: Every mutation logged to AuditLog
- **Indexing**: Strategic indexes on foreign keys and query patterns
- **Soft Deletes**: Consider for user-generated content

## Shared Package

### Contents
- **Types**: API response types, domain models, WebSocket events
- **Enums**: All domain enums (UserRole, GroupType, MessageType, etc.)
- **Constants**: App constants, limits, configuration values
- **Validation**: Zod schemas for all API inputs

### Usage
```typescript
// Frontend
import { registerSchema, UserRole } from '@socialplay/shared';

// Backend
import { registerSchema, UserRole } from '@socialplay/shared';
```

## Configuration

### Environment Variables
Managed through `@socialplay/config` package with Zod validation.

| Variable | Description | Default |
|----------|-------------|---------|
| NODE_ENV | Environment | development |
| PORT | Server port | 3000 |
| DATABASE_URL | PostgreSQL connection string | - |
| JWT_ACCESS_SECRET | Access token secret (32+ chars) | - |
| JWT_REFRESH_SECRET | Refresh token secret (32+ chars) | - |
| CORS_ORIGIN | Frontend origin | http://localhost:5173 |
| STORAGE_PROVIDER | Storage backend | local |
| REDIS_URL | Redis for Socket.IO scaling | - |

### Environments
- **Development**: `.env.local` (gitignored)
- **Test**: `.env.test` (CI)
- **Production**: Environment variables (never committed)

## Development Commands

### Root (monorepo)
```bash
# Install all dependencies
pnpm install

# Run all dev servers
pnpm dev

# Build all packages
pnpm build

# Type check all packages
pnpm typecheck

# Lint all packages
pnpm lint

# Format all files
pnpm format

# Run all tests
pnpm test

# Clean all build outputs
pnpm clean
```

### Frontend
```bash
# Dev server
pnpm --filter web dev

# Build
pnpm --filter web build

# Preview production build
pnpm --filter web preview

# Type check
pnpm --filter web typecheck

# Lint
pnpm --filter web lint

# Test
pnpm --filter web test
```

### Backend
```bash
# Dev server (with hot reload)
pnpm --filter api dev

# Build
pnpm --filter api build

# Start production
pnpm --filter api start

# Type check
pnpm --filter api typecheck

# Lint
pnpm --filter api lint

# Test
pnpm --filter api test
```

### Database
```bash
# Generate Prisma client
pnpm db:generate

# Push schema to DB (dev)
pnpm db:push

# Create migration
pnpm db:migrate

# Deploy migrations (prod)
pnpm db:migrate:deploy

# Open Prisma Studio
pnpm db:studio

# Seed database
pnpm db:seed
```

## Build Commands

### Production Build
```bash
# Build all packages
pnpm build

# Outputs:
# apps/web/dist/        - Static assets for CDN
# apps/api/dist/        - Compiled JS for Node.js
# packages/*/dist/      - Compiled packages
```

### Docker (future)
```dockerfile
# Multi-stage build for API
# Multi-stage build for Web (nginx)
```

## Testing Strategy

### Unit Tests
- **Frontend**: Vitest + React Testing Library
- **Backend**: Vitest + Fastify inject()
- **Packages**: Vitest

### Integration Tests (future)
- API contract tests
- Database integration tests

### E2E Tests (future)
- Playwright for critical user flows

### Running Tests
```bash
# All tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage
pnpm test --coverage
```

## Deployment

### Environments
1. **Development**: Local Docker Compose
2. **Staging**: Kubernetes namespace / Vercel + Railway
3. **Production**: Kubernetes / AWS ECS / Vercel + Railway

### Requirements
- PostgreSQL 15+
- Redis 7+ (for Socket.IO scaling)
- S3-compatible storage (production)
- Node.js 20+

### CI/CD Pipeline (future)
1. Lint + Typecheck
2. Unit Tests
3. Build
4. Deploy to staging
5. E2E Tests
6. Deploy to production

## Security Considerations

### Implemented
- Helmet security headers
- CORS configuration
- Rate limiting (global + auth)
- JWT in HttpOnly cookies
- Input validation (Zod)
- SQL injection prevention (Prisma)
- Request logging with request IDs

### Planned
- CSRF protection
- Content Security Policy tuning
- API versioning
- Audit logging for sensitive operations
- Encryption at rest for sensitive data

## Realtime Architecture

### Socket.IO Setup
- Namespace: `/` (default)
- Path: `/ws`
- Auth: JWT token in handshake auth
- Rooms: Per-group, per-user
- Scaling: Redis adapter (when needed)

### Events (planned)
- `join_room` / `leave_room`
- `new_message`
- `typing_start` / `typing_stop`
- `user_presence`
- `notification`

## Storage Abstraction

### Providers
- **Local**: Development (filesystem)
- **S3**: AWS S3
- **R2**: Cloudflare R2
- **MinIO**: Self-hosted S3-compatible

### Interface
```typescript
interface StorageProvider {
  upload(options): Promise<StorageFile>;
  download(options): Promise<Buffer>;
  delete(options): Promise<void>;
  getPresignedUrl(options): Promise<string>;
  fileExists(bucket, key): Promise<boolean>;
  getFileInfo(bucket, key): Promise<StorageFile | null>;
  listFiles(bucket, prefix?): Promise<StorageFile[]>;
}
```

## PWA Support

### Features
- Web App Manifest
- Service Worker (Workbox)
- Offline caching (static assets)
- Install prompt
- Push notifications (future)

### Icons
Required sizes: 72, 96, 128, 144, 152, 192, 384, 512

## Future Considerations

### Scalability
- Horizontal API scaling with Redis adapter
- Database read replicas
- CDN for static assets
- Edge caching

### Monitoring
- OpenTelemetry tracing
- Prometheus metrics
- Structured logging
- Error tracking (Sentry)

### Economy (server-authoritative)
- Transaction ledger pattern
- Idempotency keys
- Optimistic locking
- Audit trail for all balance changes