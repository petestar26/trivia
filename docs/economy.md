# SocialPlay Economy Architecture

## Overview

SocialPlay implements a dual-currency virtual economy with server-authoritative transaction processing to ensure security and integrity.

## Currencies

### Coins (Premium Currency)
- Purchased with real money
- Used for premium gifts
- Used for VIP subscriptions
- Higher value rewards

### Game Points (Earned Currency)
- Earned through gameplay
- Earned through tasks
- Earned through achievements
- Lower value rewards

## Security Model

### Critical Principle: Server Authority

The browser/client must NEVER be authoritative for:
- Balance changes
- Transaction creation
- Game outcomes
- VIP status
- Gift values

### Transaction Flow

```
Client Request
     ↓
API Authentication
     ↓
Permission Check
     ↓
Business Logic Validation
     ↓
Database Transaction
     ↓
Audit Log Entry
     ↓
Response to Client
```

### Anti-Pattern (NEVER DO THIS)

```
Client: "Set my balance to 10000 coins"
     ↓
Server: Updates balance
```

### Correct Pattern

```
Client: "Purchase gift XYZ for user ABC"
     ↓
Server: Validate user has sufficient coins
     ↓
Server: Deduct coins from wallet
     ↓
Server: Create gift record
     ↓
Server: Notify recipient
     ↓
Server: Log transaction
     ↓
Server: Return updated balance
```

## Wallet Architecture

### Wallet Table
```prisma
model Wallet {
  id          String   @id @default(uuid())
  userId      String   @unique
  coins       Int      @default(0)
  gamePoints  Int      @default(0)
  version     Int      @default(0)  // Optimistic locking
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  @@map("wallets")
}
```

### Transaction Table
```prisma
model WalletTransaction {
  id            String              @id @default(uuid())
  userId        String
  type          TransactionType
  amount        Int
  currency      TransactionCurrency
  balanceBefore Int
  balanceAfter  Int
  referenceType TransactionReferenceType
  referenceId   String
  description   String
  idempotencyKey String? @unique
  createdAt     DateTime @default(now())
  
  @@index([userId])
  @@index([referenceType, referenceId])
  @@map("wallet_transactions")
}
```

## Transaction Processing

### Idempotency
All transactions support idempotency keys to prevent duplicate processing:
- Client generates unique key
- Server checks for existing transaction with key
- If exists, returns existing result
- If not, processes transaction

### Optimistic Locking
Wallet uses version field for concurrent update protection:
```typescript
const result = await prisma.wallet.updateMany({
  where: { 
    id: walletId,
    version: currentVersion 
  },
  data: {
    coins: newBalance,
    version: { increment: 1 }
  }
});

if (result.count === 0) {
  throw new Error('Concurrent modification detected');
}
```

### Database Transactions
All multi-step operations use Prisma transactions:
```typescript
await prisma.$transaction(async (tx) => {
  // 1. Lock and update wallet
  const wallet = await tx.wallet.update({...});
  
  // 2. Create transaction record
  await tx.walletTransaction.create({...});
  
  // 3. Create related entity (gift, game result, etc.)
  await tx.giftTransaction.create({...});
  
  // 4. Create audit log
  await tx.auditLog.create({...});
});
```

## Transaction Types

### Credit Transactions
- Purchase (coins bought)
- Reward (earned from tasks/games)
- Gift received
- Admin credit
- Refund

### Debit Transactions
- Gift sent
- Game bet
- VIP purchase
- Admin debit

## Audit Trail

Every financial operation creates an audit log entry:
```typescript
{
  userId: string,
  action: 'WALLET_UPDATE' | 'GIFT_SENT' | 'GIFT_RECEIVED' | ...,
  entity: 'Wallet' | 'Gift' | 'GameSession' | ...,
  entityId: string,
  oldData: { coins: 100, gamePoints: 50 },
  newData: { coins: 80, gamePoints: 50 },
  ip: string,
  userAgent: string
}
```

## Gift Economy

### Gift Model
```prisma
model Gift {
  id             String       @id @default(uuid())
  name           String
  description    String
  imageUrl       String
  coinPrice      Int
  gamePointPrice Int?
  isAnimated     Boolean      @default(false)
  isLimited      Boolean      @default(false)
  limitedQuantity Int?
  category       GiftCategory
  isActive       Boolean      @default(true)
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
  
  @@map("gifts")
}
```

### Gift Transaction Model
```prisma
model GiftTransaction {
  id          String   @id @default(uuid())
  giftId      String
  senderId    String
  recipientId String
  groupId     String?
  message     String?
  coinValue   Int
  paidCoins   Int
  createdAt   DateTime @default(now())
  
  @@index([senderId])
  @@index([recipientId])
  @@index([groupId])
  @@map("gift_transactions")
}
```

### Gift Flow
1. Sender selects gift
2. Server validates:
   - Gift is active and available
   - Sender has sufficient coins
   - Recipient exists
3. Server processes:
   - Deduct coins from sender
   - Create gift transaction
   - Create notification for recipient
   - Broadcast via WebSocket if online
4. All steps in single database transaction

## VIP System

### VIP Tiers
- **Silver**: Basic benefits
- **Gold**: Enhanced benefits
- **Platinum**: Premium benefits

### VIP Model
```prisma
model VipMembership {
  id         String    @id @default(uuid())
  userId     String
  tier       VipTier
  status     VipStatus
  startedAt  DateTime
  expiresAt  DateTime
  autoRenew  Boolean   @default(false)
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
  
  @@index([userId])
  @@index([expiresAt])
  @@map("vip_memberships")
}
```

### VIP Benefits
- Exclusive gifts
- Discounted prices
- Special badges
- Priority support
- Increased limits

## Rate Limiting

### Economy Endpoints
Stricter rate limits for financial operations:
- Gift sending: 10 per minute
- Game playing: 30 per minute
- Wallet queries: 60 per minute

## Fraud Prevention

### Detection Mechanisms
- Unusual transaction patterns
- Multiple accounts detection
- Velocity checks
- Amount thresholds

### Prevention Measures
- Progressive delays
- Temporary locks
- Manual review flags
- Account suspension

## Analytics

### Tracked Metrics
- Total coins in circulation
- Total game points in circulation
- Daily transaction volume
- Gift velocity
- VIP conversion rate
- Purchase funnel metrics

## Admin Controls

### Capabilities
- View all wallets
- View all transactions
- Credit/debit user wallets
- Reverse transactions (with audit)
- Freeze wallets
- Generate reports

## Future Enhancements

### Phase 2
- Scheduled transactions
- Recurring VIP billing
- Gift bundles
- Seasonal gifts

### Phase 3
- Loyalty rewards
- Cashback system
- Referral bonuses
- Creator economy features

## Compliance

### Data Retention
- Transaction records: 7 years
- Audit logs: 7 years
- Anonymous aggregations: Forever

### User Rights
- View transaction history
- Export wallet data
- Dispute transactions
