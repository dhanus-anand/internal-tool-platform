# Integration — Project 1 ↔ Project 2 (Job Queue)

How the Internal Tool Platform uses the Distributed Job Queue for background processing.

---

## Overview

Project 1 (Internal Tool Platform) delegates long-running operations to Project 2 (Distributed Job Queue) rather than blocking the HTTP request:

```
User Action (Project 1 UI)
      │
      ▼
Project 1 API receives request
      │
      ▼
Enqueue job to Project 2 API
  POST http://job-queue-service/jobs
      │
      ▼
Return 202 Accepted + job_id to client
      │
      ▼ (async)
Project 2 Worker processes job
      │
      ▼
Project 2 calls webhook back to Project 1
  POST http://platform-api/api/internal/webhooks/job-complete
      │
      ▼
Project 1 updates job status
Project 1 sends notification to user (if needed)
```

---

## Job Types

### 1. `bulk_import`

User uploads a CSV file → Import all rows as tool records.

**Enqueue payload:**
```json
{
  "type": "bulk_import",
  "idempotency_key": "import-<workspace_id>-<file_id>-<timestamp>",
  "payload": {
    "workspace_id": "uuid",
    "tool_id": "uuid",
    "file_url": "https://r2.example.com/uploads/uuid/import.csv",
    "callback_url": "https://platform-api.railway.app/api/internal/webhooks/job-complete",
    "options": {
      "skip_header": true,
      "on_duplicate": "skip"  // "skip" | "overwrite" | "error"
    }
  }
}
```

**Worker behavior (in Project 2):**
1. Download file from `file_url`
2. Parse CSV headers → Map to tool schema fields
3. Validate each row against tool schema
4. Batch-insert valid records into `tool_records` (INSERT in batches of 500)
5. Skip or reject invalid rows (based on `on_duplicate`)
6. Send webhook callback with result

**Callback payload (success):**
```json
{
  "job_id": "uuid",
  "status": "completed",
  "result": {
    "total_rows": 5000,
    "imported": 4987,
    "skipped": 10,
    "errors": 3,
    "error_details": [
      {"row": 42, "field": "email", "message": "Invalid email format"},
      {"row": 156, "field": "status", "message": "Invalid enum value 'pending'"}
    ]
  }
}
```

---

### 2. `bulk_export`

User requests CSV/JSON export of all (or filtered) records.

**Enqueue payload:**
```json
{
  "type": "bulk_export",
  "idempotency_key": "export-<workspace_id>-<tool_id>-<timestamp>",
  "payload": {
    "workspace_id": "uuid",
    "tool_id": "uuid",
    "format": "csv",  // "csv" | "json"
    "filters": {
      "status": "active"
    },
    "callback_url": "https://platform-api.railway.app/api/internal/webhooks/job-complete",
    "upload_to": {
      "bucket": "itp-exports",
      "key": "workspaces/uuid/exports/uuid.csv"
    }
  }
}
```

**Worker behavior:**
1. Query tool records with filters (paginated internally, 1000 at a time)
2. Stream results to CSV/JSON file
3. Upload generated file to S3/R2
4. Generate pre-signed download URL (24h expiry)
5. Send webhook callback with download URL

**Callback payload (success):**
```json
{
  "job_id": "uuid",
  "status": "completed",
  "result": {
    "record_count": 4987,
    "file_size_bytes": 2048576,
    "download_url": "https://r2.example.com/exports/uuid.csv?signature=...",
    "expires_at": "2024-12-25T12:00:00Z"
  }
}
```

---

### 3. `bulk_delete`

User selects many records → Delete them all asynchronously.

**Enqueue payload:**
```json
{
  "type": "bulk_delete",
  "idempotency_key": "delete-<workspace_id>-<request_hash>",
  "payload": {
    "workspace_id": "uuid",
    "tool_id": "uuid",
    "record_ids": ["uuid1", "uuid2", "...up to 10000 ids"],
    "callback_url": "https://platform-api.railway.app/api/internal/webhooks/job-complete",
    "initiated_by": "user-uuid"
  }
}
```

**Worker behavior:**
1. Validate all `record_ids` belong to `workspace_id`/`tool_id` (security check)
2. Delete in batches of 500
3. Create a single audit log entry (bulk delete by user X at time Y)
4. Send webhook callback

**Callback payload:**
```json
{
  "job_id": "uuid",
  "status": "completed",
  "result": {
    "deleted_count": 1000,
    "not_found_count": 5
  }
}
```

---

### 4. `report_generation`

Generate a PDF or Excel report for a workspace.

**Enqueue payload:**
```json
{
  "type": "report_generation",
  "payload": {
    "workspace_id": "uuid",
    "report_type": "tool_summary",
    "params": {
      "tool_id": "uuid",
      "date_range": { "from": "2024-01-01", "to": "2024-12-31" }
    },
    "format": "pdf",
    "callback_url": "https://platform-api.railway.app/api/internal/webhooks/job-complete"
  }
}
```

---

## Project 1 Implementation

### Job Service

```typescript
// src/jobs/jobs.service.ts
@Injectable()
export class JobsService {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async enqueue(
    workspaceId: string,
    type: JobType,
    payload: Record<string, any>,
    userId: string,
  ) {
    const idempotencyKey = `${type}-${workspaceId}-${Date.now()}`;
    
    const response = await this.http.post(
      `${this.config.get('JOB_QUEUE_URL')}/jobs`,
      {
        type,
        idempotency_key: idempotencyKey,
        payload: {
          ...payload,
          callback_url: `${this.config.get('API_URL')}/api/internal/webhooks/job-complete`,
        },
      },
    ).toPromise();
    
    // Track job in our own database
    return this.prisma.jobRecord.create({
      data: {
        workspaceId,
        externalJobId: response.data.job_id,
        type,
        status: 'PENDING',
        initiatedBy: userId,
      },
    });
  }
}
```

### Webhook Handler

```typescript
// src/jobs/webhooks.controller.ts
@Controller('internal/webhooks')
export class WebhooksController {
  
  @Post('job-complete')
  @UseGuards(WebhookSignatureGuard)   // Verify HMAC signature from Project 2
  async handleJobComplete(@Body() body: JobCompleteWebhookDto) {
    const { job_id, status, result } = body;
    
    await this.jobsService.updateJobStatus(job_id, status, result);
    
    // Notify user if they're watching this job
    await this.notificationsService.notifyJobComplete(job_id, status, result);
    
    return { received: true };
  }
}
```

### Webhook Signature Verification

```typescript
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const signature = request.headers['x-webhook-signature'];
    const rawBody = request.rawBody;
    
    const expectedSig = createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(`sha256=${expectedSig}`),
    );
  }
}
```

---

## Job Status Tracking

Project 1 maintains its own job tracking table:

```sql
-- Add to schema.prisma
model JobRecord {
  id              String    @id @default(uuid())
  workspaceId     String
  externalJobId   String    @unique    -- Job ID from Project 2
  type            String
  status          String    -- PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED
  result          Json?
  initiatedBy     String?
  createdAt       DateTime  @default(now())
  completedAt     DateTime?
  
  workspace       Workspace @relation(fields: [workspaceId], references: [id])
  @@map("job_records")
}
```

The UI polls `GET /api/workspaces/:wid/jobs/:jid` for job status updates.

---

## Error Handling

### Job Failure Callback

```json
{
  "job_id": "uuid",
  "status": "failed",
  "error": {
    "code": "IMPORT_PARSE_ERROR",
    "message": "Unable to parse CSV: invalid encoding",
    "retryable": false
  }
}
```

Project 1 handling:
1. Update `JobRecord.status` to `FAILED`
2. Store error in `JobRecord.result`
3. Notify user with error message
4. Allow user to retry (re-enqueue same job type)

### Network Failures (Webhook Not Received)

If Project 1 doesn't receive a webhook within a reasonable time:
1. Background polling: Check `GET /jobs/:id` on Project 2 API every 30s
2. If job is `completed` in Project 2 but not in Project 1: process retroactively
3. If job is `failed` in Project 2: surface error to user

---

## Standalone Operation

**Project 1 without Project 2:**

Operations gracefully degrade when the job queue is unavailable:
- Bulk import: Return error "Background jobs unavailable, please try later"
- Export: Synchronously export for small datasets (< 1000 records), else error
- Bulk delete: Synchronously delete for small batches (< 100 records), else error

```typescript
// Configurable fallback
const JOB_QUEUE_ENABLED = process.env.JOB_QUEUE_URL !== undefined;

if (!JOB_QUEUE_ENABLED || recordIds.length < 100) {
  // Synchronous path
  return this.recordsService.deleteMany(workspaceId, toolId, recordIds);
}

// Async path via job queue
return this.jobsService.enqueue(workspaceId, 'bulk_delete', { ... });
```
