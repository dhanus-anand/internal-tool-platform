# Architecture — Internal Tool Platform

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Browser                           │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS
┌────────────────────────▼────────────────────────────────────────┐
│                    Next.js Frontend                             │
│  App Router │ React Query │ Tailwind CSS │ Dynamic Tables       │
└────────────────────────┬────────────────────────────────────────┘
                         │ REST API (JSON)
┌────────────────────────▼────────────────────────────────────────┐
│                    NestJS Backend API                           │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐  │
│  │   Auth   │ │Workspaces│ │  Tools   │ │  Tool Records   │  │
│  │  Module  │ │  Module  │ │  Module  │ │    (Dynamic)    │  │
│  └──────────┘ └──────────┘ └──────────┘ └─────────────────┘  │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐  │
│  │  Files   │ │  Jobs    │ │  Audit   │ │   API Keys      │  │
│  │  Module  │ │  Module  │ │   Log    │ │    Module       │  │
│  └──────────┘ └──────────┘ └──────────┘ └─────────────────┘  │
└────┬──────────────────┬──────────────────┬──────────────────────┘
     │                  │                  │
┌────▼────┐      ┌──────▼─────┐    ┌──────▼──────┐
│PostgreSQL│      │   Redis    │    │   S3 / R2   │
│(Primary) │      │  (Cache)   │    │  (Storage)  │
└─────────┘      └────────────┘    └─────────────┘
                         │
               ┌─────────▼──────────┐
               │  Project 2:        │
               │  Job Queue System  │
               └────────────────────┘
```

---

## Multi-Tenancy Architecture

### Tenant Isolation Strategy

Every piece of data is scoped to a `workspace_id`. This is enforced at multiple layers:

**Layer 1: Application Logic**
- Every request that accesses data must pass through workspace authorization middleware
- The authenticated user's workspace membership is loaded and checked on every request
- Services only query data where `workspaceId` matches

**Layer 2: Database Queries**
- All Prisma queries include `WHERE workspace_id = ?` clauses
- Never query without `workspaceId` filter when accessing tenant data
- Database indexes include `workspace_id` as the leading column

**Layer 3: Prisma-Level Enforcement**
```typescript
// All service methods receive the workspaceId from the authenticated context
// Example pattern:
async findToolRecords(workspaceId: string, toolId: string, query: PaginationDto) {
  return this.prisma.toolRecord.findMany({
    where: {
      workspaceId,   // ← Always scoped
      toolId,
    },
    // ...
  });
}
```

**Future: Row-Level Security (PostgreSQL)**
```sql
-- Production hardening: PostgreSQL RLS as defense-in-depth
ALTER TABLE tool_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON tool_records
  USING (workspace_id = current_setting('app.workspace_id')::uuid);
```

---

## Data Flow: Schema → API → UI

```
1. Builder defines schema (JSON)
         │
         ▼
2. POST /api/workspaces/:wid/tools
   - Validates schema structure
   - Stores schema in tools.schema (JSONB)
   - Creates audit log entry
         │
         ▼
3. Schema stored in PostgreSQL (tools table)
   {
     "name": "customers",
     "fields": [
       {"name": "email", "type": "string", "required": true}
     ]
   }
         │
         ▼
4. Dynamic API endpoints become available:
   GET    /api/workspaces/:wid/tools/:tid/records
   POST   /api/workspaces/:wid/tools/:tid/records
   GET    /api/workspaces/:wid/tools/:tid/records/:rid
   PATCH  /api/workspaces/:wid/tools/:tid/records/:rid
   DELETE /api/workspaces/:wid/tools/:tid/records/:rid
         │
         ▼
5. Frontend fetches schema:
   GET /api/workspaces/:wid/tools/:tid
   → Returns schema definition
         │
         ▼
6. Frontend renders dynamic table:
   - Columns derived from schema.fields
   - Column types determine rendering (text, enum badge, date, etc.)
   - Filters generated from field types
   - Form inputs generated for create/edit
```

---

## API Layer Design

### Route Structure

```
/api
├── /auth
│   ├── POST /login
│   ├── POST /register
│   ├── POST /refresh
│   └── POST /logout
│
├── /workspaces
│   ├── GET    /                          # List workspaces (for current user)
│   ├── POST   /                          # Create workspace
│   ├── GET    /:workspaceId              # Get workspace
│   ├── PATCH  /:workspaceId              # Update workspace
│   ├── DELETE /:workspaceId              # Delete workspace
│   │
│   ├── /users
│   │   ├── GET    /:workspaceId/users    # List members
│   │   ├── POST   /:workspaceId/users    # Invite user
│   │   ├── PATCH  /:workspaceId/users/:userId  # Update role
│   │   └── DELETE /:workspaceId/users/:userId  # Remove user
│   │
│   ├── /tools
│   │   ├── GET    /:workspaceId/tools
│   │   ├── POST   /:workspaceId/tools
│   │   ├── GET    /:workspaceId/tools/:toolId
│   │   ├── PATCH  /:workspaceId/tools/:toolId
│   │   └── DELETE /:workspaceId/tools/:toolId
│   │
│   ├── /records (Dynamic — generated per tool)
│   │   ├── GET    /:workspaceId/tools/:toolId/records
│   │   ├── POST   /:workspaceId/tools/:toolId/records
│   │   ├── GET    /:workspaceId/tools/:toolId/records/:recordId
│   │   ├── PATCH  /:workspaceId/tools/:toolId/records/:recordId
│   │   └── DELETE /:workspaceId/tools/:toolId/records/:recordId
│   │
│   ├── /files
│   │   ├── POST   /:workspaceId/files/presign  # Get pre-signed upload URL
│   │   └── DELETE /:workspaceId/files/:fileId
│   │
│   ├── /jobs
│   │   ├── GET    /:workspaceId/jobs
│   │   ├── POST   /:workspaceId/jobs
│   │   └── GET    /:workspaceId/jobs/:jobId
│   │
│   ├── /api-keys
│   │   ├── GET    /:workspaceId/api-keys
│   │   ├── POST   /:workspaceId/api-keys
│   │   └── DELETE /:workspaceId/api-keys/:keyId
│   │
│   └── /audit
│       └── GET    /:workspaceId/audit-logs
```

### Request Lifecycle

```
Incoming Request
      │
      ▼
1. JwtAuthGuard (or ApiKeyGuard)
   - Validates JWT / API key
   - Attaches user to request context
      │
      ▼
2. WorkspaceMemberGuard
   - Verifies user belongs to the workspace in the URL
   - Loads role for that workspace
   - Attaches workspace context
      │
      ▼
3. RbacGuard (on specific actions)
   - Checks if role has required permission
   - e.g., @RequireRole(WorkspaceRole.BUILDER)
      │
      ▼
4. DTO Validation (class-validator)
   - Validates and transforms request body
      │
      ▼
5. Controller
   - Extracts workspace context from request
   - Calls service
      │
      ▼
6. Service
   - Business logic
   - Always scoped to workspaceId
      │
      ▼
7. Prisma Query
   - Always includes WHERE workspace_id = ?
      │
      ▼
8. AuditService (on mutations)
   - Logs: who, workspace, action, resource, metadata
      │
      ▼
9. Response
```

---

## Dynamic Record System

### The Core Insight

Tool records use a JSONB column (`data`) in PostgreSQL. This allows storing arbitrary structured data without schema migrations each time a tool is defined.

```sql
-- tool_records table
id          UUID PRIMARY KEY
tool_id     UUID → tools.id
workspace_id UUID → workspaces.id
data        JSONB   ← all field values live here
created_by  UUID
created_at  TIMESTAMP
updated_at  TIMESTAMP
```

### Querying JSONB Data

PostgreSQL's JSONB supports indexed queries:

```sql
-- Exact match filter
SELECT * FROM tool_records
WHERE workspace_id = $1
  AND tool_id = $2
  AND data->>'status' = 'active';

-- Range filter
SELECT * FROM tool_records
WHERE workspace_id = $1
  AND (data->>'amount')::numeric > 100;

-- GIN index for fast JSONB queries
CREATE INDEX idx_tool_records_data ON tool_records USING GIN (data);
```

### Validation Strategy

Validation happens at the API layer, using the tool's schema:

```typescript
// DynamicValidationPipe reads tool schema and validates incoming data
class DynamicValidationPipe implements PipeTransform {
  async transform(value: any, metadata: ArgumentMetadata) {
    const schema = await this.toolsService.getToolSchema(toolId);
    const errors = validateAgainstSchema(value, schema);
    if (errors.length > 0) throw new BadRequestException(errors);
    return value;
  }
}
```

---

## Database Schema

See [prisma/schema.prisma](prisma/schema.prisma) for the complete schema.

Key design decisions:

1. **JSONB for tool records** — Flexible storage without schema migrations per tool
2. **Cascade deletes** — Deleting a workspace removes all its data
3. **Soft deletes** — `isActive` flag on workspaces, tools, users (no hard deletes for audit purposes)
4. **UUID primary keys** — No sequential IDs that reveal record counts
5. **Indexes on foreign keys + workspace_id** — All tenant-scoped queries are fast

---

## Authentication & Security

### JWT Token Flow

```
1. POST /api/auth/login
   → Returns { accessToken (24h), refreshToken (7d) }

2. Client stores tokens in httpOnly cookies (or memory for SPA)

3. Every request: Authorization: Bearer <accessToken>

4. On 401: POST /api/auth/refresh with refreshToken
   → Returns new accessToken
   → Rotates refreshToken (old one invalidated)

5. Refresh tokens stored in Redis with TTL
   → Instant revocation possible
```

### API Key Authentication

```
1. POST /api/workspaces/:wid/api-keys
   → Server generates: key = "itp_" + randomBytes(32)
   → Stores: SHA-256(key) in database (never the plaintext)
   → Returns plaintext key ONCE to user

2. API requests with key:
   Authorization: Bearer itp_xxxxx
   (or X-API-Key: itp_xxxxx)

3. Server hashes incoming key, looks up hash in database
   → Attaches workspace context
   → Respects key scopes

4. Rate limiting: 100 req/min per API key (Redis-backed ThrottlerGuard)
```

---

## Frontend Architecture

### Component Structure

```
src/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx          # Workspace sidebar layout
│   │   ├── workspaces/
│   │   │   └── [workspaceId]/
│   │   │       ├── page.tsx    # Workspace overview
│   │   │       ├── tools/
│   │   │       │   ├── page.tsx           # Tool list
│   │   │       │   ├── new/page.tsx       # Schema editor
│   │   │       │   └── [toolId]/
│   │   │       │       ├── page.tsx       # Data table view
│   │   │       │       └── records/new/page.tsx
│   │   │       ├── settings/
│   │   │       │   ├── members/page.tsx
│   │   │       │   └── api-keys/page.tsx
│   │   │       ├── jobs/page.tsx
│   │   │       └── audit/page.tsx
│   └── layout.tsx
│
├── components/
│   ├── ui/                  # Base components (Button, Input, Modal, etc.)
│   ├── data-table/          # Dynamic data table with schema-driven columns
│   ├── schema-editor/       # JSON schema editor with field builder
│   └── layout/              # Sidebar, header, breadcrumbs
│
└── lib/
    ├── api/                 # Axios client, API function wrappers
    ├── auth/                # Auth context, token management
    ├── types/               # TypeScript interfaces
    └── utils/               # cn(), formatDate(), etc.
```

### Data Fetching Strategy

React Query is used for all server state:

```typescript
// Tools and records use React Query for caching and background refetch
const { data: tool } = useQuery({
  queryKey: ['tools', workspaceId, toolId],
  queryFn: () => api.getTool(workspaceId, toolId),
  staleTime: 5 * 60 * 1000,   // Schema rarely changes
});

const { data: records, isLoading } = useQuery({
  queryKey: ['records', workspaceId, toolId, filters],
  queryFn: () => api.getRecords(workspaceId, toolId, filters),
  staleTime: 30 * 1000,        // Records change more frequently
});
```

---

## Deployment Architecture

### Current (Railway, ~$5/month)

```
Railway Project
├── Backend Service    (NestJS, Docker)
├── Frontend Service   (Next.js, Docker)
├── PostgreSQL Plugin  (Railway managed)
└── Redis Plugin       (or Upstash free tier)

External:
└── Cloudflare R2      (file storage, free tier)
```

### Environment Variables (Railway)

```
DATABASE_URL        = postgresql://...
REDIS_URL           = redis://...
JWT_SECRET          = ...
R2_ACCESS_KEY_ID    = ...
R2_SECRET_ACCESS_KEY = ...
R2_BUCKET_NAME      = ...
FRONTEND_URL        = https://your-app.railway.app
```

See [SCALING.md](SCALING.md) for the AWS production architecture targeting 1000+ workspaces.
