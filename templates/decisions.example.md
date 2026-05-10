# Duostack — Architectural Decisions

*Record all significant architectural decisions here using `ds_record_decision`.
This file is the strategic memory of the project — always commit it.*

*Format: Claude writes these automatically. Antigravity reads but never edits.*

---

## D-2026-04-12-001 — JWT authentication strategy
**Date:** 2026-04-12
**Status:** FINAL

**Decision:** Use JWT with 15-minute access token expiry and rotating refresh tokens stored in HttpOnly cookies.

**Rationale:** Short expiry limits damage from token theft. Rotating refresh tokens allow invalidation without server-side state. HttpOnly cookies prevent XSS access.

**Constraints:**
- All tokens must be invalidatable (refresh token blacklist required)
- Refresh tokens must rotate on every use
- Do not re-evaluate this without a security review

---

## D-2026-04-12-002 — Database connection pooling
**Date:** 2026-04-12
**Status:** PROVISIONAL

**Decision:** Use pg-pool with max 10 connections per instance. Revisit when scaling beyond single instance.

**Rationale:** Simple, works for current load. pg-pool handles reconnection automatically.

**Constraints:**
- Single instance only — connection count must be reviewed before horizontal scaling

---
