# Internal Tool Platform

A multi-tenant platform for building internal admin tools through JSON schemas — like a scoped-down Retool focused on form-driven CRUD operations.

**"Instead of building 10 different admin dashboards, build one platform that generates them from schemas."**

> **Portfolio context:** This is Project 1 of 3. The story: building this platform revealed that background processing (bulk imports, exports, deletions) needed to be a separate, reliable concern — which led directly to [Project 2: Distributed Job Queue](../project-2-distributed-job-queue). These two projects are independently usable but designed to integrate.

---

## What It Does

Define a JSON schema → Get a full CRUD admin tool instantly:

```json
{
  "name": "customers",
  "fields": [
    {"name": "email", "type": "string", "required": true, "unique": true},
    {"name": "name", "type": "string", "required": true},
    {"name": "status", "type": "enum", "options": ["active", "inactive"]},
    {"name": "created_at", "type": "timestamp", "auto": true}
  ]
}
```

The platform auto-generates:
- A full REST API (`/api/workspaces/:id/tools/:id/records`)
- A filterable, sortable, paginated data table UI
- Validation rules based on field definitions
- Audit logging for all mutations

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS, React Query |
| Backend | NestJS, TypeScript, Node.js 20+ |
| Database | PostgreSQL 16 (primary), Prisma ORM |
| Cache | Redis (Upstash free tier in prod) |
| Storage | Cloudflare R2 or AWS S3 (file uploads) |
| Auth | Custom JWT with NestJS Guards (no third-party providers) |
| Background Jobs | Project 2 — Distributed Job Queue |
| Deployment | Railway (~$5/month) or Docker self-hosted |
| CI/CD | GitHub Actions |

---

## Features

- **Multi-tenant workspaces** — full tenant isolation, all data scoped by `workspace_id`
- **RBAC** — 5 role levels: WORKSPACE_OWNER, ADMIN, BUILDER, MEMBER, VIEWER
- **JSON schema builder** — define data models declaratively
- **Auto-generated REST APIs** — schema → endpoints with validation, pagination, filtering
- **Dynamic data tables** — frontend renders from schema, supports inline editing, bulk ops
- **File uploads** — S3/R2 with pre-signed URLs, file metadata stored in PostgreSQL
- **Background jobs** — bulk import/export/delete via Project 2 job queue
- **Audit logging** — every mutation logged: who, what, when, where
- **API key auth** — programmatic access with scoped permissions

---

## Project Structure

```
project-1-internal-tool-platform/
├── frontend/           # Next.js 14 frontend
│   └── src/
│       ├── app/        # App Router pages and layouts
│       ├── components/ # Reusable UI components
│       └── lib/        # API clients, utilities, types
├── backend/            # NestJS API server
│   └── src/
│       ├── auth/       # JWT auth, guards, strategies
│       ├── workspaces/ # Workspace and user management
│       ├── tools/      # Schema management
│       ├── jobs/       # Background job integration
│       └── common/     # Shared utilities, decorators
├── prisma/
│   └── schema.prisma   # Full database schema
├── .github/workflows/  # CI/CD pipelines
└── docker-compose.yml  # Local development environment
```

---

## Quick Start

### Prerequisites
- Node.js 20+
- Docker & Docker Compose

### Local Development

```bash
# 1. Clone and install
git clone <repo-url>
cd project-1-internal-tool-platform

# 2. Environment setup
cp .env.example .env
# Edit .env with your values

# 3. Start infrastructure
docker-compose up postgres redis -d

# 4. Backend setup
cd backend
npm install
npm run db:generate
npm run db:migrate
npm run start:dev

# 5. Frontend setup (new terminal)
cd frontend
npm install
npm run dev
```

Frontend: http://localhost:3000  
Backend API: http://localhost:4000  
API Docs (Swagger): http://localhost:4000/api/docs

### Full Stack with Docker

```bash
docker-compose up --build
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, components, data flow |
| [DYNAMIC_GENERATION.md](DYNAMIC_GENERATION.md) | How schemas become APIs |
| [RBAC_DESIGN.md](RBAC_DESIGN.md) | Permission model and authorization flow |
| [INTEGRATION.md](INTEGRATION.md) | Project 2 job queue integration |
| [SCALING.md](SCALING.md) | Railway → AWS production scaling |
| [OPUS_AGENT_INSTRUCTIONS.md](OPUS_AGENT_INSTRUCTIONS.md) | Build instructions for Opus agent |

---

## Performance Targets

- API response time: p95 < 200ms
- Page load: < 2 seconds
- 100 concurrent users supported
- 10,000 tool records per workspace

---

## Cost

| Service | Cost |
|---------|------|
| Railway (backend + frontend) | ~$5/month |
| Upstash Redis | Free (10k commands/day) |
| Cloudflare R2 | Free (10GB storage, 1M reads) |
| Neon PostgreSQL | Free (0.5GB) |
| **Total** | **~$5/month** |

---

## Integration with Project 2

This platform integrates with the [Distributed Job Queue](../project-2-distributed-job-queue) for background operations:

- **bulk_import** — Parse and import CSV files into tool records
- **bulk_export** — Export tool records to CSV/JSON, upload to S3
- **bulk_delete** — Delete records in batches
- **report_generation** — Generate PDF/Excel reports

See [INTEGRATION.md](INTEGRATION.md) for full details.
