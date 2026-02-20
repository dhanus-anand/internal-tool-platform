# Scaling Strategy — Internal Tool Platform

From Railway prototype to AWS production serving 1000+ workspaces.

---

## Current Architecture (Railway, ~$5/month)

```
Railway Project
├── Backend (NestJS)    1x container, 512MB RAM, 0.5 vCPU
├── Frontend (Next.js)  1x container, 256MB RAM
├── PostgreSQL          Railway plugin, 1GB storage
└── Redis               Upstash free tier (10k commands/day)

Estimated capacity: ~50 active users, 100 workspaces
Monthly cost: ~$5
```

**Bottlenecks at this tier:**
- Single backend container: No horizontal scaling
- Railway PostgreSQL: Limited connection pool, no read replicas
- Upstash free tier: 10k Redis commands/day limit
- No CDN for frontend assets
- No background job worker (uses Project 2 separately)

---

## Scaling Tier 2: Railway Pro (~$20-40/month)

```
Railway Pro
├── Backend          2x replicas, autoscale up to 4
├── Frontend         Next.js on Vercel (free tier)
├── PostgreSQL       Railway plugin, 5GB, connection pooling
└── Redis            Upstash Pro ($10/month, 100k commands/day)

Estimated capacity: ~500 active users, 1000 workspaces
```

Key changes:
- Replicated backend → Must use Redis for session storage (not in-memory)
- Sticky sessions not needed (JWT is stateless)
- Refresh token blacklist stored in Redis (supports multi-instance)

---

## Scaling Tier 3: AWS Production (~$100-200/month)

Target: 10,000+ workspaces, 100,000+ users

### Architecture

```
                        ┌─────────────────┐
                        │   Route 53      │
                        │   (DNS)         │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐
                        │  CloudFront     │
                        │  (CDN + WAF)    │
                        └────────┬────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     ┌────────▼────────┐         │        ┌─────────▼───────┐
     │  Next.js on     │         │        │   API Gateway   │
     │  Vercel / S3+CF │         │        │   (rate limit)  │
     └─────────────────┘         │        └─────────┬───────┘
                                 │                  │
                        ┌────────▼────────┐         │
                        │   ALB           │◄────────┘
                        │   (Load Bal.)   │
                        └────────┬────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     ┌────────▼────┐    ┌────────▼────┐    ┌────────▼────┐
     │  NestJS     │    │  NestJS     │    │  NestJS     │
     │  ECS Task   │    │  ECS Task   │    │  ECS Task   │
     │  (Fargate)  │    │  (Fargate)  │    │  (Fargate)  │
     └─────────────┘    └─────────────┘    └─────────────┘
              │                  │                  │
              └──────────────────┼──────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     ┌────────▼────┐    ┌────────▼────┐    ┌────────▼────┐
     │  RDS Postgres│    │ ElastiCache │    │   S3/R2     │
     │  (Primary + │    │  Redis      │    │  (Files)    │
     │  1 Replica) │    │  Cluster    │    └─────────────┘
     └─────────────┘    └─────────────┘
```

### AWS Services Used

| Service | Purpose | Cost Estimate |
|---------|---------|---------------|
| ECS Fargate | NestJS containers (autoscaling) | ~$40/month (2-4 tasks) |
| RDS PostgreSQL | Primary + 1 read replica | ~$50/month |
| ElastiCache Redis | Caching, sessions, rate limiting | ~$20/month |
| ALB | Load balancing | ~$15/month |
| CloudFront | CDN, WAF, DDoS protection | ~$5/month |
| S3 | File storage | ~$5/month |
| Route 53 | DNS | ~$1/month |
| **Total** | | **~$135/month** |

---

## Bottleneck Analysis

### Bottleneck 1: Database Query Performance

**Problem:** JSONB queries on `tool_records` table get slow at 1M+ records.

**Current mitigation:**
- GIN index on `data` column for general queries
- Selective B-tree indexes per-tool for common filter fields
- Connection pooling (PgBouncer or Prisma Accelerate)
- Read replica for GET requests

**Long-term solution:** Partition `tool_records` by `workspace_id` (hash partitioning)

```sql
-- Partition by workspace_id (when table reaches 100M+ rows)
CREATE TABLE tool_records_p (
  LIKE tool_records INCLUDING ALL
) PARTITION BY HASH (workspace_id);

CREATE TABLE tool_records_p0 PARTITION OF tool_records_p
  FOR VALUES WITH (modulus 4, remainder 0);
-- ... create 4 partitions
```

### Bottleneck 2: Large Workspace Queries

**Problem:** A workspace with 100k records in one tool hits query time limits.

**Mitigation:**
- Enforce pagination (max 100 records per page)
- Async export for large datasets (via Project 2)
- Query timeouts (20s max)
- Result count caching (approximate counts via `EXPLAIN ANALYZE`)

### Bottleneck 3: File Upload Throughput

**Problem:** Multiple simultaneous large file uploads saturate backend.

**Solution:** Pre-signed URLs (already designed)
- Client uploads directly to S3/R2 (never through backend)
- Backend only generates pre-signed URLs and stores metadata
- Max upload size: 50MB per file, enforced by S3 policy

### Bottleneck 4: Redis Rate Limiting at Scale

**Problem:** Redis single-instance becomes a bottleneck at high concurrency.

**Solution:** Redis Cluster (ElastiCache)
- Hash slot-based sharding across 3+ nodes
- Rate limiting keys distributed by user/IP

---

## Scaling to 1000+ Custom Tools

Each workspace can create unlimited tools (up to plan limits). At 1000+ total tools across all workspaces:

**Schema caching is critical:**
- All tool schemas cached in Redis with 5-minute TTL
- Schema updates invalidate the cache immediately
- Redis memory: ~10KB per schema × 10,000 tools = ~100MB

**Record table management:**
- All records in single `tool_records` table with tool_id + workspace_id composite index
- No per-tool tables (would require migrations per tool creation)
- Table partitioning when `tool_records` > 500M rows

---

## Database Sharding Strategy (Future)

When outgrowing a single PostgreSQL instance (estimated: 10,000+ active workspaces):

### Tenant-Based Sharding

```
Shard 0: workspace_ids 0x00... - 0x3F...
Shard 1: workspace_ids 0x40... - 0x7F...
Shard 2: workspace_ids 0x80... - 0xBF...
Shard 3: workspace_ids 0xC0... - 0xFF...
```

**Application-level shard routing:**
```typescript
function getShardId(workspaceId: string): number {
  const firstByte = parseInt(workspaceId.replace(/-/g, '').substring(0, 2), 16);
  return Math.floor(firstByte / 64); // 4 shards
}
```

**Trade-offs:**
- Cross-workspace queries become impossible (acceptable — we never query across tenants)
- Each shard is an independent PostgreSQL instance
- Rebalancing is complex — do this early before data grows

### Alternative: Citus (PostgreSQL Extension)

Citus allows PostgreSQL-native distributed tables without application-level sharding logic. Better for this use case since SQL stays unchanged.

---

## Deployment Pipeline

```
Git push to main
       │
       ▼
GitHub Actions CI
  - Lint + Type check
  - Unit tests
  - Integration tests (ephemeral DB)
  - Build Docker images
  - Push to ECR
       │
       ▼
Staging deployment (auto)
  - Migrate DB (prisma migrate deploy)
  - Deploy to staging ECS service
  - Smoke tests
       │
       ▼
Production deployment (manual approval)
  - Blue/green deployment via ECS
  - Zero-downtime migration
  - Rollback available (previous task definition)
```
