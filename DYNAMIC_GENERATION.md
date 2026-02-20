# Dynamic API Generation — Internal Tool Platform

How JSON schemas become fully functional REST APIs at runtime.

---

## The Core Mechanism

The platform does **not** generate code or run migrations when a new tool schema is created. Instead, it uses a single set of dynamic endpoints that interpret the schema at request time.

This is different from most code-generation approaches:

```
Traditional approach:
  Schema → Code generation → New files → Recompile → Deploy

Our approach:
  Schema → Stored in DB → Dynamic endpoints interpret it at runtime
```

---

## Schema Definition Format

Every tool is defined by a JSON schema stored in `tools.schema` (JSONB column).

### Full Schema Specification

```typescript
interface ToolSchema {
  name: string;
  description?: string;
  fields: FieldDefinition[];
  settings?: SchemaSettings;
}

interface FieldDefinition {
  name: string;           // Snake_case identifier
  label?: string;         // Display label (defaults to capitalized name)
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  default?: any;
  
  // Type-specific options
  options?: string[];              // For enum fields
  min?: number;                    // For number fields
  max?: number;                    // For number fields
  minLength?: number;              // For string fields
  maxLength?: number;              // For string fields
  pattern?: string;                // Regex for string validation
  precision?: number;              // For decimal fields
  relatedTool?: string;            // For relation fields
  multiple?: boolean;              // For file fields
  acceptedTypes?: string[];        // For file fields (MIME types)
  auto?: boolean;                  // For timestamp fields (auto-set)
}

type FieldType =
  | 'string'
  | 'text'       // Multi-line string
  | 'number'
  | 'decimal'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'timestamp'
  | 'email'
  | 'url'
  | 'file'
  | 'json';

interface SchemaSettings {
  allowBulkDelete?: boolean;
  allowExport?: boolean;
  allowImport?: boolean;
  recordsPerPage?: number;
  defaultSort?: { field: string; direction: 'asc' | 'desc' };
}
```

### Example Schemas

**Customer Management Tool:**
```json
{
  "name": "customers",
  "description": "Track customer accounts",
  "fields": [
    {"name": "email", "type": "email", "required": true, "unique": true},
    {"name": "full_name", "type": "string", "required": true, "maxLength": 100},
    {"name": "status", "type": "enum", "options": ["active", "inactive", "churned"], "default": "active"},
    {"name": "monthly_spend", "type": "decimal", "precision": 2},
    {"name": "notes", "type": "text"},
    {"name": "created_at", "type": "timestamp", "auto": true}
  ],
  "settings": {
    "allowBulkDelete": true,
    "allowExport": true,
    "allowImport": true
  }
}
```

**Bug Tracker Tool:**
```json
{
  "name": "bugs",
  "fields": [
    {"name": "title", "type": "string", "required": true},
    {"name": "severity", "type": "enum", "options": ["critical", "high", "medium", "low"]},
    {"name": "status", "type": "enum", "options": ["open", "in_progress", "resolved", "closed"]},
    {"name": "assignee_email", "type": "email"},
    {"name": "description", "type": "text"},
    {"name": "screenshot", "type": "file", "acceptedTypes": ["image/*"]},
    {"name": "reported_at", "type": "timestamp", "auto": true}
  ]
}
```

---

## Dynamic Endpoint Implementation

### Single Controller, Dynamic Behavior

NestJS doesn't support true dynamic routing natively. The approach is a single `ToolRecordsController` that handles all record operations and delegates to the dynamic record service:

```typescript
@Controller('workspaces/:workspaceId/tools/:toolId/records')
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard)
export class ToolRecordsController {

  @Get()
  async findAll(
    @Param('workspaceId') workspaceId: string,
    @Param('toolId') toolId: string,
    @Query() query: RecordQueryDto,
    @CurrentWorkspaceUser() user: WorkspaceUser,
  ) {
    return this.recordsService.findAll(workspaceId, toolId, query);
  }

  @Post()
  @RequirePermission('records:create')
  async create(
    @Param('workspaceId') workspaceId: string,
    @Param('toolId') toolId: string,
    @Body() body: Record<string, any>,
    @CurrentWorkspaceUser() user: WorkspaceUser,
  ) {
    // 1. Load tool schema
    const tool = await this.toolsService.findOne(workspaceId, toolId);
    
    // 2. Validate body against schema
    const errors = this.schemaValidator.validate(body, tool.schema);
    if (errors.length) throw new BadRequestException(errors);
    
    // 3. Process auto fields (timestamps, defaults)
    const processedData = this.schemaProcessor.processAutoFields(body, tool.schema);
    
    // 4. Create record
    const record = await this.recordsService.create(workspaceId, toolId, processedData, user.userId);
    
    // 5. Audit log
    await this.auditService.log({ workspaceId, userId: user.userId, action: 'CREATE', resource: 'record', resourceId: record.id });
    
    return record;
  }
  
  // PATCH and DELETE follow similar pattern
}
```

---

## Dynamic Validation

### Schema-to-Validator Mapping

The `SchemaValidatorService` converts field definitions to validation rules at runtime:

```typescript
@Injectable()
export class SchemaValidatorService {
  
  validate(data: Record<string, any>, schema: ToolSchema): ValidationError[] {
    const errors: ValidationError[] = [];
    
    for (const field of schema.fields) {
      const value = data[field.name];
      
      // Required check
      if (field.required && (value === undefined || value === null || value === '')) {
        errors.push({ field: field.name, message: `${field.label || field.name} is required` });
        continue;
      }
      
      if (value === undefined || value === null) continue; // Optional field not provided
      
      // Type-specific validation
      switch (field.type) {
        case 'string':
        case 'text':
          if (typeof value !== 'string') {
            errors.push({ field: field.name, message: 'Must be a string' });
          } else {
            if (field.minLength && value.length < field.minLength)
              errors.push({ field: field.name, message: `Minimum ${field.minLength} characters` });
            if (field.maxLength && value.length > field.maxLength)
              errors.push({ field: field.name, message: `Maximum ${field.maxLength} characters` });
            if (field.pattern && !new RegExp(field.pattern).test(value))
              errors.push({ field: field.name, message: 'Invalid format' });
          }
          break;
          
        case 'email':
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
            errors.push({ field: field.name, message: 'Invalid email address' });
          break;
          
        case 'number':
        case 'decimal':
          const num = Number(value);
          if (isNaN(num)) {
            errors.push({ field: field.name, message: 'Must be a number' });
          } else {
            if (field.min !== undefined && num < field.min)
              errors.push({ field: field.name, message: `Minimum value is ${field.min}` });
            if (field.max !== undefined && num > field.max)
              errors.push({ field: field.name, message: `Maximum value is ${field.max}` });
          }
          break;
          
        case 'enum':
          if (!field.options?.includes(value))
            errors.push({ field: field.name, message: `Must be one of: ${field.options?.join(', ')}` });
          break;
          
        case 'boolean':
          if (typeof value !== 'boolean')
            errors.push({ field: field.name, message: 'Must be true or false' });
          break;
          
        case 'url':
          try { new URL(value); }
          catch { errors.push({ field: field.name, message: 'Invalid URL' }); }
          break;
      }
    }
    
    return errors;
  }
}
```

### Uniqueness Validation

For fields marked `unique: true`, uniqueness is checked against the database:

```typescript
async validateUniqueness(
  workspaceId: string,
  toolId: string,
  data: Record<string, any>,
  schema: ToolSchema,
  excludeRecordId?: string,
): Promise<ValidationError[]> {
  const uniqueFields = schema.fields.filter(f => f.unique);
  const errors: ValidationError[] = [];
  
  for (const field of uniqueFields) {
    const value = data[field.name];
    if (value === undefined) continue;
    
    const existing = await this.prisma.toolRecord.findFirst({
      where: {
        workspaceId,
        toolId,
        data: { path: [field.name], equals: value },
        ...(excludeRecordId ? { NOT: { id: excludeRecordId } } : {}),
      },
    });
    
    if (existing) {
      errors.push({ field: field.name, message: `${value} is already taken` });
    }
  }
  
  return errors;
}
```

---

## Dynamic Query Building

### Filtering

Query parameters are mapped to JSONB filter conditions:

```typescript
// URL: GET /records?filters[status]=active&filters[email]=john@example.com
// Becomes:
interface RecordQueryDto {
  filters?: Record<string, string>;
  sort?: string;          // "created_at" or "-created_at" (prefix - = desc)
  page?: number;
  limit?: number;
  search?: string;        // Full-text search across all string fields
}

async findAll(workspaceId: string, toolId: string, query: RecordQueryDto) {
  const tool = await this.toolsService.findOne(workspaceId, toolId);
  
  // Build WHERE conditions
  const whereConditions: Prisma.ToolRecordWhereInput = {
    workspaceId,
    toolId,
  };
  
  if (query.filters) {
    // JSONB path filters
    const jsonbConditions = Object.entries(query.filters).map(([field, value]) => ({
      data: { path: [field], equals: value },
    }));
    // Note: Prisma doesn't natively support complex JSONB filtering
    // Use raw queries for complex cases
  }
  
  // Sort
  let orderBy: Prisma.ToolRecordOrderByWithRelationInput = { createdAt: 'desc' };
  if (query.sort) {
    const sortField = query.sort.startsWith('-') ? query.sort.slice(1) : query.sort;
    const sortDir = query.sort.startsWith('-') ? 'desc' : 'asc';
    // Sorting on JSONB fields requires raw SQL
    // orderBy = Prisma.sql`data->>'${sortField}' ${sortDir}`
  }
  
  const [records, total] = await this.prisma.$transaction([
    this.prisma.toolRecord.findMany({
      where: whereConditions,
      skip: ((query.page || 1) - 1) * (query.limit || 20),
      take: query.limit || 20,
    }),
    this.prisma.toolRecord.count({ where: whereConditions }),
  ]);
  
  return {
    data: records,
    pagination: {
      page: query.page || 1,
      limit: query.limit || 20,
      total,
      totalPages: Math.ceil(total / (query.limit || 20)),
    },
  };
}
```

---

## Frontend Dynamic Rendering

### Schema → Table Columns

The frontend converts schema fields to table column definitions:

```typescript
function schemaToColumns(schema: ToolSchema): ColumnDef[] {
  return schema.fields
    .filter(field => !field.auto || field.name !== 'created_at') // Optionally include auto fields
    .map(field => ({
      key: field.name,
      header: field.label || capitalize(field.name.replace(/_/g, ' ')),
      type: field.type,
      renderCell: (value: any) => {
        switch (field.type) {
          case 'enum':
            return <EnumBadge value={value} options={field.options} />;
          case 'boolean':
            return <BooleanToggle value={value} />;
          case 'timestamp':
          case 'date':
            return <DateCell value={value} />;
          case 'url':
            return <LinkCell href={value} />;
          case 'file':
            return <FileCell fileId={value} />;
          default:
            return <TextCell value={value} />;
        }
      },
      filterComponent: getFilterComponent(field),
    }));
}
```

### Schema → Form Fields

The same schema drives the create/edit form:

```typescript
function schemaToFormFields(schema: ToolSchema): FormFieldDef[] {
  return schema.fields
    .filter(field => !field.auto)
    .map(field => ({
      name: field.name,
      label: field.label || capitalize(field.name),
      type: fieldTypeToInputType(field.type),
      required: field.required,
      options: field.options,
      validation: buildZodRule(field),
    }));
}

function buildZodRule(field: FieldDefinition) {
  // Dynamically build Zod validation rules matching server-side rules
  switch (field.type) {
    case 'email': return z.string().email();
    case 'url': return z.string().url();
    case 'number': return z.number().min(field.min ?? -Infinity).max(field.max ?? Infinity);
    case 'enum': return z.enum(field.options as [string, ...string[]]);
    default: return z.string();
  }
}
```

---

## Auto Fields Processing

Fields with `auto: true` are handled server-side:

```typescript
function processAutoFields(
  data: Record<string, any>,
  schema: ToolSchema,
): Record<string, any> {
  const processed = { ...data };
  
  for (const field of schema.fields) {
    if (field.auto) {
      switch (field.type) {
        case 'timestamp':
          processed[field.name] = new Date().toISOString();
          break;
        case 'string':
          // Could be auto-generated IDs, slugs, etc.
          break;
      }
    }
    
    // Apply defaults for missing optional fields
    if (field.default !== undefined && processed[field.name] === undefined) {
      processed[field.name] = field.default;
    }
  }
  
  return processed;
}
```

---

## Performance Considerations

### JSONB Indexing Strategy

```sql
-- GIN index for general JSONB queries
CREATE INDEX idx_tool_records_data_gin ON tool_records USING GIN (data);

-- B-tree indexes for frequently filtered fields (added per tool if needed)
CREATE INDEX idx_tool_records_data_status 
  ON tool_records ((data->>'status'))
  WHERE tool_id = '<specific-tool-id>';
```

### Schema Caching

Schemas are cached in Redis to avoid DB reads on every request:

```typescript
async getToolSchema(workspaceId: string, toolId: string): Promise<ToolSchema> {
  const cacheKey = `schema:${workspaceId}:${toolId}`;
  
  const cached = await this.redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  
  const tool = await this.prisma.tool.findFirst({
    where: { id: toolId, workspaceId, isActive: true },
  });
  
  if (!tool) throw new NotFoundException('Tool not found');
  
  // Cache for 5 minutes (schema changes are rare)
  await this.redis.setex(cacheKey, 300, JSON.stringify(tool.schema));
  
  return tool.schema as ToolSchema;
}
```
