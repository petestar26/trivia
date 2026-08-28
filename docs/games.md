# SocialPlay Games Architecture

## Overview

SocialPlay includes casual mini-games that provide entertainment and opportunities to earn rewards. All games are server-authoritative to ensure fairness and prevent cheating.

## V1 Games

### Lucky Spin
- Wheel of fortune style game
- Multiple reward segments
- Visual spin animation
- Server-determined outcome

### Dice
- Simple dice rolling game
- Bet on high/low or specific numbers
- Multiplier-based rewards
- Server-generated randomness

### Trivia
- Question-based game
- Multiple choice answers
- Time-limited responses
- Score-based rewards

### Number Challenge
- Number guessing game
- Limited attempts
- Proximity hints
- Fixed rewards for success

## Security Model

### Critical Principle: Server Authority

The browser/client must NEVER determine:
- Game outcomes
- Reward amounts
- Win/loss results
- Random number generation

### Game Flow

```
Client: "Play Lucky Spin with 10 coins"
     ↓
Server: Validate user has 10 coins
     ↓
Server: Deduct 10 coins (atomic)
     ↓
Server: Generate cryptographically secure random result
     ↓
Server: Calculate reward based on result
     ↓
Server: Credit reward to wallet (if any)
     ↓
Server: Record game session
     ↓
Server: Return outcome to client
     ↓
Client: Display animation matching server result
```

### Anti-Pattern (NEVER DO THIS)

```
Client: Generates random result
     ↓
Client: "I won 100 coins!"
     ↓
Server: Credits 100 coins
```

## Game Session Architecture

### Game Session Model
```prisma
model GameSession {
  id          String            @id @default(uuid())
  userId      String
  gameType    GameType
  status      GameSessionStatus
  betAmount   Int               @default(0)
  currency    TransactionCurrency
  result      Json?
  reward      Int               @default(0)
  rewardCurrency TransactionCurrency?
  createdAt   DateTime          @default(now())
  completedAt DateTime?
  
  @@index([userId])
  @@index([gameType])
  @@index([createdAt])
  @@map("game_sessions")
}
```

### Game Definition Model
```prisma
model GameDefinition {
  id          String   @id @default(uuid())
  type        GameType @unique
  name        String
  description String
  minBet      Int
  maxBet      Int
  currencies  TransactionCurrency[]
  isActive    Boolean  @default(true)
  config      Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  @@map("game_definitions")
}
```

## Random Number Generation

### Cryptographic Security
Use Node.js crypto module for secure randomness:
```typescript
import { randomInt, randomBytes } from 'crypto';

// For integer ranges
const result = randomInt(0, 100);

// For weighted selections
const buffer = randomBytes(4);
const value = buffer.readUInt32BE(0);
```

### Weighted Probability
```typescript
interface WeightedOption {
  value: string;
  weight: number;
}

function selectWeighted(options: WeightedOption[]): string {
  const totalWeight = options.reduce((sum, opt) => sum + opt.weight, 0);
  const random = randomInt(0, totalWeight);
  
  let cumulative = 0;
  for (const option of options) {
    cumulative += option.weight;
    if (random < cumulative) {
      return option.value;
    }
  }
  
  return options[options.length - 1].value;
}
```

## Game Implementations

### Lucky Spin Configuration
```typescript
interface LuckySpinConfig {
  segments: Array<{
    label: string;
    weight: number;
    reward: number;
    rewardType: 'coins' | 'gamePoints';
  }>;
  animationDuration: number; // ms
}
```

### Dice Configuration
```typescript
interface DiceConfig {
  outcomes: {
    high: { multiplier: number; probability: number };
    low: { multiplier: number; probability: number };
    exact: { multiplier: number; probability: number };
  };
}
```

### Trivia Configuration
```typescript
interface TriviaConfig {
  questions: Array<{
    id: string;
    question: string;
    options: string[];
    correctIndex: number;
    difficulty: 'easy' | 'medium' | 'hard';
    reward: number;
    timeLimit: number; // seconds
  }>;
}
```

## Transaction Integration

### Bet Processing
```typescript
async function processBet(
  userId: string,
  gameType: GameType,
  betAmount: number,
  currency: TransactionCurrency
): Promise<GameSession> {
  return await prisma.$transaction(async (tx) => {
    // 1. Lock wallet
    const wallet = await tx.wallet.findUnique({
      where: { userId },
      select: { [currency]: true, version: true }
    });
    
    // 2. Validate balance
    if (wallet[currency] < betAmount) {
      throw new InsufficientFundsError();
    }
    
    // 3. Deduct bet
    await tx.wallet.update({
      where: { userId, version: wallet.version },
      data: {
        [currency]: { decrement: betAmount },
        version: { increment: 1 }
      }
    });
    
    // 4. Create session
    const session = await tx.gameSession.create({
      data: {
        userId,
        gameType,
        betAmount,
        currency,
        status: GameSessionStatus.IN_PROGRESS
      }
    });
    
    // 5. Log transaction
    await tx.walletTransaction.create({
      data: {
        userId,
        type: TransactionType.DEBIT,
        amount: betAmount,
        currency,
        referenceType: TransactionReferenceType.GAME,
        referenceId: session.id,
        description: `Bet for ${gameType}`
      }
    });
    
    return session;
  });
}
```

### Reward Processing
```typescript
async function processReward(
  session: GameSession,
  rewardAmount: number,
  rewardCurrency: TransactionCurrency
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // 1. Credit reward
    await tx.wallet.update({
      where: { userId: session.userId },
      data: {
        [rewardCurrency]: { increment: rewardAmount }
      }
    });
    
    // 2. Update session
    await tx.gameSession.update({
      where: { id: session.id },
      data: {
        status: GameSessionStatus.COMPLETED,
        reward: rewardAmount,
        rewardCurrency,
        completedAt: new Date()
      }
    });
    
    // 3. Log transaction
    await tx.walletTransaction.create({
      data: {
        userId: session.userId,
        type: TransactionType.CREDIT,
        amount: rewardAmount,
        currency: rewardCurrency,
        referenceType: TransactionReferenceType.GAME,
        referenceId: session.id,
        description: `Reward from ${session.gameType}`
      }
    });
  });
}
```

## Rate Limiting

### Per-Game Limits
- Lucky Spin: 30 per hour
- Dice: 60 per hour
- Trivia: 20 per hour
- Number Challenge: 30 per hour

### Bet Limits
- Minimum bet: Configured per game
- Maximum bet: Configured per game
- Daily loss limit: User-configurable with hard cap

## Leaderboards

### Game-Specific Leaderboards
- Highest single win
- Most games played
- Highest total winnings
- Win streak

### Scoring
```typescript
interface LeaderboardEntry {
  userId: string;
  score: number;
  metric: 'single_win' | 'games_played' | 'total_winnings' | 'win_streak';
  period: 'daily' | 'weekly' | 'monthly' | 'all_time';
}
```

## Analytics

### Tracked Metrics
- Games played per day
- Total bets placed
- Total rewards distributed
- Win rate by game
- Average bet size
- Popular games
- Peak play times

## Admin Controls

### Capabilities
- Configure game parameters
- Adjust probabilities
- Set bet limits
- Enable/disable games
- View all game sessions
- Investigate suspicious activity
- Refund bets (with audit)

## Future Enhancements

### Phase 2
- Group games (multiplayer)
- Tournaments
- Seasonal games
- Achievement integration

### Phase 3
- AI opponents
- Custom game creation
- Streaming integration
- Esports features

## Compliance

### Fair Play
- Provably fair algorithms (future)
- Published probability tables
- Independent audits
- Responsible gaming features

### Responsible Gaming
- Self-exclusion options
- Deposit limits
- Loss limits
- Time limits
- Cooling-off periods
