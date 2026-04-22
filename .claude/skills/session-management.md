# Skill: Session Management & Multitenancy

## Scope
Session lifecycle, `x-session-id` enforcement, Redis invalidation on document delete, rate limiting.
Use this skill when touching: `SessionGuard`, any Prisma query on a shared table, Redis cache invalidation, rate limiter config.

---

## The Invariant

**Every single database query that touches `document_chunks`, `documents`, or `messages` MUST include `WHERE session_id = $sessionId`.**

No exceptions. This is the sole multitenancy mechanism.

---

## Session Lifecycle

### Client-Side (Next.js)
```typescript
// On every page load
let sessionId = localStorage.getItem('session_id');
if (!sessionId) {
  sessionId = crypto.randomUUID();   // UUIDv4
  localStorage.setItem('session_id', sessionId);
}
// Attach to every request
headers['x-session-id'] = sessionId;
```

### Server-Side (NestJS Guard)
```typescript
@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const sessionId = req.headers['x-session-id'];
    if (!sessionId || !isUUID(sessionId)) {
      throw new BadRequestException('Missing or invalid x-session-id header');
    }
    req.sessionId = sessionId;   // attach to request for downstream use
    return true;
  }
}
// Apply globally or per-controller — not optional
```

### Session Record Creation (lazy)
```typescript
// Create session row if it doesn't exist — use upsert to avoid race conditions
await prisma.session.upsert({
  where: { id: sessionId },
  create: { id: sessionId },
  update: {},   // do not overwrite existing session data
});
```

---

## Rate Limiting

```typescript
// In app.module.ts or chat.module.ts
ThrottlerModule.forRoot([{
  name: 'chat',
  ttl: 60_000,   // 1 minute window
  limit: 10,     // max 10 messages per session per minute
}])
// Key by session_id, not IP (to allow shared networks)
ThrottlerGuard → override getTracker() → return req.headers['x-session-id']
```

---

## Redis Cache Invalidation

```typescript
// Call this on ANY document deletion for the session
async invalidateSessionCache(sessionId: string): Promise<void> {
  const pattern = `semantic:${sessionId}:*`;
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
```

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| User clears localStorage | New UUID generated on next visit — previous session data orphaned in DB |
| Incognito window | Generates new UUID — treated as brand new session |
| Same user, different device | Two independent sessions — no sync |
| Missing `x-session-id` header | `400 Bad Request` — never fall through to a query |
| Non-UUID `session_id` value | `400 Bad Request` — validate format before DB touch |

---

## Orphaned Data (Future Work)
Sessions where no activity has occurred for > 30 days are candidates for cleanup via a nightly cron.  
Not yet implemented — flag as a known tech debt item.
