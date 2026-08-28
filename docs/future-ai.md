# SocialPlay Future AI Architecture

## Overview

SocialPlay is designed to be AI-ready, with a planned multi-agent system for customer support, moderation, payments, community management, analytics, and operations. This document defines the architecture that will enable safe, controlled AI integration.

## AI Architecture Principles

### Core Principle: AI Never Directly Accesses Database

AI agents interact with the system through controlled tools/APIs, never directly with PostgreSQL.

### Architecture Flow

```
User/AI Request
     ↓
Tool Layer
     ↓
Permission Check
     ↓
Business Logic
     ↓
Database
     ↓
Audit Log
     ↓
Response
```

### Anti-Pattern (NEVER DO THIS)

```
AI Agent
     ↓
Direct SQL/Prisma Access
     ↓
Database
```

### Correct Pattern

```
AI Agent
     ↓
Tool: "GetUserProfile(userId)"
     ↓
Permission Check: Can AI access this?
     ↓
API: GET /users/:id/profile
     ↓
Business Logic
     ↓
Database Query
     ↓
Sanitized Response
```

## Multi-Agent System

### Supervisor AI
Orchestrates and coordinates all specialized AI agents.

**Responsibilities:**
- Route requests to appropriate agents
- Monitor agent performance
- Handle escalations
- Manage context across agents
- Ensure compliance with policies

### Support AI
Handles customer support inquiries.

**Capabilities:**
- Answer FAQs
- Guide users through features
- Troubleshoot common issues
- Create support tickets
- Escalate to human agents

**Tools:**
- `searchFAQ(query)`
- `getUserInfo(userId)`
- `createTicket(userId, issue)`
- `searchDocs(query)`
- `escalateToHuman(ticketId, reason)`

### Moderation AI
Assists with content moderation.

**Capabilities:**
- Flag potentially violating content
- Suggest moderation actions
- Analyze user behavior patterns
- Generate moderation reports
- Recommend bans/warnings

**Tools:**
- `reviewContent(contentId)`
- `getUserHistory(userId)`
- `flagContent(contentId, reason)`
- `suggestAction(contentId)`
- `generateReport(filters)`

### Payment AI
Assists with payment and economy inquiries.

**Capabilities:**
- Explain transaction history
- Investigate disputed transactions
- Detect fraud patterns
- Generate financial reports
- Process refunds (with approval)

**Tools:**
- `getTransactionHistory(userId, filters)`
- `getWalletBalance(userId)`
- `investigateTransaction(transactionId)`
- `flagSuspiciousActivity(userId)`
- `initiateRefund(transactionId, reason)` (requires human approval)

### Community AI
Manages community engagement and health.

**Capabilities:**
- Monitor group health
- Suggest community events
- Identify engaged users
- Analyze group dynamics
- Recommend group improvements

**Tools:**
- `getGroupHealth(groupId)`
- `getTopContributors(groupId)`
- `suggestEvents(groupId)`
- `analyzeEngagement(filters)`
- `getCommunityMetrics()`

### Analytics AI
Provides insights and analytics.

**Capabilities:**
- Generate reports
- Answer data questions
- Identify trends
- Predict user behavior
- Recommend optimizations

**Tools:**
- `getMetric(metricName, filters)`
- `generateReport(type, filters)`
- `queryAnalytics(naturalLanguageQuery)`
- `getTrends(metric, period)`
- `predictChurn(filters)`

### Operations AI
Assists with platform operations.

**Capabilities:**
- Monitor system health
- Detect anomalies
- Optimize resource usage
- Automate routine tasks
- Generate operational reports

**Tools:**
- `getSystemHealth()`
- `getMetrics(component)`
- `detectAnomalies(filters)`
- `getLogs(filters)`
- `executeMaintenanceTask(taskId)` (requires approval)

## Tool Architecture

### Tool Definition

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  permissions: string[];
  rateLimit: RateLimitConfig;
  auditEnabled: boolean;
  requiresApproval: boolean;
  execute: (params: unknown, context: ToolContext) => Promise<ToolResult>;
}

interface ToolContext {
  agentId: string;
  agentType: AgentType;
  userId?: string;
  requestId: string;
  timestamp: Date;
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  auditData?: Record<string, unknown>;
}
```

### Tool Registry

```typescript
class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }
  
  async execute(
    toolName: string, 
    params: unknown, 
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }
    
    // Validate parameters
    this.validateParams(tool, params);
    
    // Check permissions
    await this.checkPermissions(tool, context);
    
    // Check rate limit
    await this.checkRateLimit(tool, context);
    
    // Execute
    const result = await tool.execute(params, context);
    
    // Audit log
    if (tool.auditEnabled) {
      await this.createAuditLog(tool, params, result, context);
    }
    
    // Request approval if needed
    if (tool.requiresApproval && result.success) {
      await this.requestApproval(tool, params, result, context);
    }
    
    return result;
  }
}
```

### Tool Implementation Example

```typescript
const getUserInfoTool: Tool = {
  name: 'getUserInfo',
  description: 'Get user profile information',
  parameters: {
    type: 'object',
    properties: {
      userId: { type: 'string', format: 'uuid' }
    },
    required: ['userId']
  },
  permissions: ['users:read'],
  rateLimit: { points: 100, duration: 60 },
  auditEnabled: true,
  requiresApproval: false,
  
  execute: async (params: { userId: string }, context: ToolContext) => {
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        createdAt: true,
        status: true,
        role: true
      }
    });
    
    if (!user) {
      return { success: false, error: 'User not found' };
    }
    
    return { 
      success: true, 
      data: user,
      auditData: { userId: user.id, action: 'read' }
    };
  }
};
```

## Permission System

### Permission Model

```typescript
enum AgentPermission {
  // User permissions
  USERS_READ = 'users:read',
  USERS_WRITE = 'users:write',
  
  // Content permissions
  CONTENT_READ = 'content:read',
  CONTENT_MODERATE = 'content:moderate',
  
  // Economy permissions
  ECONOMY_READ = 'economy:read',
  ECONOMY_WRITE = 'economy:write',
  
  // Admin permissions
  ADMIN_READ = 'admin:read',
  ADMIN_WRITE = 'admin:write',
  
  // System permissions
  SYSTEM_READ = 'system:read',
  SYSTEM_WRITE = 'system:write',
}

interface AgentRole {
  name: string;
  permissions: AgentPermission[];
  rateLimits: Record<string, RateLimitConfig>;
  allowedTools: string[];
}

const SUPPORT_AGENT_ROLE: AgentRole = {
  name: 'support',
  permissions: [
    AgentPermission.USERS_READ,
    AgentPermission.CONTENT_READ
  ],
  rateLimits: {
    default: { points: 100, duration: 60 }
  },
  allowedTools: [
    'getUserInfo',
    'searchFAQ',
    'createTicket',
    'searchDocs'
  ]
};
```

## Audit System

### AI Audit Log

```typescript
model AIAuditLog {
  id          String   @id @default(uuid())
  agentId     String
  agentType   String
  tool        String
  params      Json
  result      Json
  success     Boolean
  userId      String?
  requestId   String
  duration    Int
  createdAt   DateTime @default(now())
  
  @@index([agentId])
  @@index([agentType])
  @@index([tool])
  @@index([createdAt])
  @@map("ai_audit_logs")
}
```

### Audit Entry Creation

```typescript
async function createAuditLog(
  tool: Tool,
  params: unknown,
  result: ToolResult,
  context: ToolContext
): Promise<void> {
  await prisma.aIAuditLog.create({
    data: {
      agentId: context.agentId,
      agentType: context.agentType,
      tool: tool.name,
      params: params,
      result: { 
        success: result.success,
        error: result.error 
      },
      success: result.success,
      userId: context.userId,
      requestId: context.requestId,
      duration: Date.now() - context.timestamp.getTime()
    }
  });
}
```

## Safety Guardrails

### Content Filtering
- No PII exposure in AI responses
- No financial secrets in logs
- No user credentials in context
- No internal system details

### Action Limits
- AI cannot delete data
- AI cannot modify critical settings
- AI cannot process payments directly
- AI cannot bypass moderation

### Approval Workflow

```typescript
interface ApprovalRequest {
  id: string;
  toolName: string;
  params: unknown;
  agentId: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string;
  reviewedAt?: Date;
  reason?: string;
}

async function requestApproval(
  tool: Tool,
  params: unknown,
  result: ToolResult,
  context: ToolContext
): Promise<void> {
  const request = await prisma.approvalRequest.create({
    data: {
      toolName: tool.name,
      params,
      agentId: context.agentId,
      status: 'pending'
    }
  });
  
  // Notify human reviewers
  await notifyReviewers(request);
  
  // Wait for approval (with timeout)
  const approved = await waitForApproval(request.id, 300000); // 5 min
  
  if (!approved) {
    throw new Error('Action not approved within timeout');
  }
}
```

## Implementation Phases

### Phase 1: Tool Foundation (Future)
- Implement tool registry
- Define core tools
- Create permission system
- Set up audit logging

### Phase 2: Support AI (Future)
- FAQ search tool
- User info tool
- Ticket creation tool
- Basic support agent

### Phase 3: Moderation AI (Future)
- Content review tool
- User history tool
- Flagging tool
- Moderation suggestions

### Phase 4: Analytics AI (Future)
- Metrics query tool
- Report generation tool
- Trend analysis tool
- Insights generation

### Phase 5: Full Multi-Agent (Future)
- Supervisor agent
- All specialized agents
- Cross-agent coordination
- Advanced approval workflows

## Security Considerations

### Authentication
- Each AI agent has unique API key
- JWT-based agent identity
- Rotating secrets

### Network Security
- AI agents on private network
- No public API exposure
- mTLS for tool communication

### Data Access
- Minimal necessary permissions
- Data masking for sensitive fields
- No access to credentials/secrets

### Monitoring
- Real-time AI activity monitoring
- Anomaly detection on AI actions
- Automatic suspension on violations
