# RBAC Design — Internal Tool Platform

Role-Based Access Control system with 5 role levels and hierarchical permissions.

---

## Role Hierarchy

```
WORKSPACE_OWNER
      │
      ▼
    ADMIN
      │
      ▼
   BUILDER
      │
      ▼
   MEMBER
      │
      ▼
   VIEWER
```

Higher roles inherit all permissions of lower roles.

---

## Role Definitions

| Role | Description | Typical User |
|------|-------------|--------------|
| `WORKSPACE_OWNER` | Full control, billing, cannot be removed | Founder, team lead |
| `ADMIN` | Manage tools, users, all data | Engineering manager |
| `BUILDER` | Create and edit tools, all data access | Developer, ops |
| `MEMBER` | Use tools, create/edit records | Business user |
| `VIEWER` | Read-only access | Stakeholder, auditor |

---

## Permission Matrix

| Permission | VIEWER | MEMBER | BUILDER | ADMIN | OWNER |
|-----------|--------|--------|---------|-------|-------|
| View workspace | ✅ | ✅ | ✅ | ✅ | ✅ |
| View tools | ✅ | ✅ | ✅ | ✅ | ✅ |
| View records | ✅ | ✅ | ✅ | ✅ | ✅ |
| Export records | ❌ | ✅ | ✅ | ✅ | ✅ |
| Create records | ❌ | ✅ | ✅ | ✅ | ✅ |
| Edit records | ❌ | ✅ | ✅ | ✅ | ✅ |
| Delete records | ❌ | ❌ | ✅ | ✅ | ✅ |
| Bulk delete | ❌ | ❌ | ✅ | ✅ | ✅ |
| Create tools | ❌ | ❌ | ✅ | ✅ | ✅ |
| Edit tool schema | ❌ | ❌ | ✅ | ✅ | ✅ |
| Delete tools | ❌ | ❌ | ❌ | ✅ | ✅ |
| Manage members | ❌ | ❌ | ❌ | ✅ | ✅ |
| Manage API keys | ❌ | ❌ | ❌ | ✅ | ✅ |
| View audit logs | ❌ | ❌ | ❌ | ✅ | ✅ |
| Delete workspace | ❌ | ❌ | ❌ | ❌ | ✅ |
| Transfer ownership | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## Implementation

### Role Enum

```typescript
// prisma/schema.prisma
enum WorkspaceRole {
  WORKSPACE_OWNER
  ADMIN
  BUILDER
  MEMBER
  VIEWER
}
```

### Permission Constants

```typescript
// src/auth/rbac/permissions.ts
export enum Permission {
  // Records
  RECORDS_READ = 'records:read',
  RECORDS_CREATE = 'records:create',
  RECORDS_UPDATE = 'records:update',
  RECORDS_DELETE = 'records:delete',
  RECORDS_BULK_DELETE = 'records:bulk_delete',
  RECORDS_EXPORT = 'records:export',
  RECORDS_IMPORT = 'records:import',
  
  // Tools
  TOOLS_READ = 'tools:read',
  TOOLS_CREATE = 'tools:create',
  TOOLS_UPDATE = 'tools:update',
  TOOLS_DELETE = 'tools:delete',
  
  // Workspace
  WORKSPACE_MEMBERS_READ = 'workspace:members:read',
  WORKSPACE_MEMBERS_MANAGE = 'workspace:members:manage',
  WORKSPACE_API_KEYS_MANAGE = 'workspace:api_keys:manage',
  WORKSPACE_AUDIT_READ = 'workspace:audit:read',
  WORKSPACE_DELETE = 'workspace:delete',
}

export const ROLE_PERMISSIONS: Record<WorkspaceRole, Permission[]> = {
  [WorkspaceRole.VIEWER]: [
    Permission.RECORDS_READ,
    Permission.TOOLS_READ,
  ],
  [WorkspaceRole.MEMBER]: [
    Permission.RECORDS_READ,
    Permission.RECORDS_CREATE,
    Permission.RECORDS_UPDATE,
    Permission.RECORDS_EXPORT,
    Permission.TOOLS_READ,
  ],
  [WorkspaceRole.BUILDER]: [
    Permission.RECORDS_READ,
    Permission.RECORDS_CREATE,
    Permission.RECORDS_UPDATE,
    Permission.RECORDS_DELETE,
    Permission.RECORDS_BULK_DELETE,
    Permission.RECORDS_EXPORT,
    Permission.RECORDS_IMPORT,
    Permission.TOOLS_READ,
    Permission.TOOLS_CREATE,
    Permission.TOOLS_UPDATE,
  ],
  [WorkspaceRole.ADMIN]: [
    // All BUILDER permissions plus:
    Permission.RECORDS_READ,
    Permission.RECORDS_CREATE,
    Permission.RECORDS_UPDATE,
    Permission.RECORDS_DELETE,
    Permission.RECORDS_BULK_DELETE,
    Permission.RECORDS_EXPORT,
    Permission.RECORDS_IMPORT,
    Permission.TOOLS_READ,
    Permission.TOOLS_CREATE,
    Permission.TOOLS_UPDATE,
    Permission.TOOLS_DELETE,
    Permission.WORKSPACE_MEMBERS_READ,
    Permission.WORKSPACE_MEMBERS_MANAGE,
    Permission.WORKSPACE_API_KEYS_MANAGE,
    Permission.WORKSPACE_AUDIT_READ,
  ],
  [WorkspaceRole.WORKSPACE_OWNER]: [
    // All permissions
    ...Object.values(Permission),
  ],
};

export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
```

### NestJS Guards

```typescript
// src/auth/guards/rbac.guard.ts
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  
  canActivate(context: ExecutionContext): boolean {
    const requiredPermission = this.reflector.get<Permission>(
      PERMISSION_KEY,
      context.getHandler(),
    );
    
    if (!requiredPermission) return true; // No permission required
    
    const request = context.switchToHttp().getRequest();
    const workspaceUser: WorkspaceUserContext = request.workspaceUser;
    
    if (!workspaceUser) return false;
    
    return hasPermission(workspaceUser.role, requiredPermission);
  }
}

// Decorator
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);
```

### Usage in Controllers

```typescript
@Controller('workspaces/:workspaceId/tools')
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RbacGuard)
export class ToolsController {

  @Get()
  @RequirePermission(Permission.TOOLS_READ)
  findAll() { ... }

  @Post()
  @RequirePermission(Permission.TOOLS_CREATE)
  create() { ... }

  @Delete(':toolId')
  @RequirePermission(Permission.TOOLS_DELETE)
  remove() { ... }
}
```

---

## Workspace Member Guard

```typescript
// src/auth/guards/workspace-member.guard.ts
@Injectable()
export class WorkspaceMemberGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
  ) {}
  
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;
    const workspaceId = request.params.workspaceId;
    
    if (!workspaceId) return true; // Route doesn't require workspace
    
    const membership = await this.prisma.workspaceUser.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: user.sub,
        },
      },
    });
    
    if (!membership) throw new ForbiddenException('Not a member of this workspace');
    
    // Attach workspace context for downstream guards and handlers
    request.workspaceUser = {
      userId: user.sub,
      workspaceId,
      role: membership.role,
    };
    
    return true;
  }
}
```

---

## Role Management Rules

### Who Can Change Roles

```
WORKSPACE_OWNER: Can set any role (including ADMIN)
ADMIN: Can set BUILDER, MEMBER, VIEWER (cannot assign ADMIN or OWNER)
BUILDER/MEMBER/VIEWER: Cannot manage roles
```

### Edge Cases

1. **Last owner protection**: Cannot remove the last WORKSPACE_OWNER
   ```typescript
   // Before role change / removal, check:
   const ownerCount = await prisma.workspaceUser.count({
     where: { workspaceId, role: WorkspaceRole.WORKSPACE_OWNER }
   });
   if (ownerCount === 1 && currentRole === 'WORKSPACE_OWNER') {
     throw new BadRequestException('Cannot remove the last workspace owner');
   }
   ```

2. **Self-demotion protection**: OWNER cannot demote themselves (prevents lockout)

3. **Admin cannot elevate to OWNER**: Only an existing OWNER can create another OWNER

4. **API key scopes**: API keys inherit a maximum of the creator's role

### Invite Flow

```
1. ADMIN invites user@example.com with role MEMBER
   → Creates pending WorkspaceUser with status 'invited'
   → Sends email with invite link

2. User clicks invite link
   → If no account: prompted to register
   → If account exists: prompted to accept

3. User accepts
   → WorkspaceUser.status → 'active'
   → User can now access workspace
```

---

## API Key RBAC

API keys also carry permission scopes:

```typescript
interface ApiKeyScopes {
  // Explicit scopes on the key
  scopes: string[];  // e.g., ['records:read', 'records:create']
  
  // Keys are also bounded by the creating user's role
  // A MEMBER cannot create a key with ADMIN permissions
}
```

On request with API key:
1. Load API key from DB (by hash)
2. Load workspace context from key's workspace_id
3. Check: requested action ∈ key.scopes
4. Check: requested action ∈ ROLE_PERMISSIONS[creatingUser.role]
5. Both must be satisfied
