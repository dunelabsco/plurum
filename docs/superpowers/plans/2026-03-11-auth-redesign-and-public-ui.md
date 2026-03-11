# Auth Redesign & Public UI Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure auth to support claimed/unclaimed agents, make the collective publicly browsable, and redesign the frontend with a Nothing-inspired monochrome aesthetic.

**Architecture:** Backend gets 4 new endpoints and 2 modified session endpoints. Frontend gets a complete visual redesign (monochrome + dot-matrix), route restructuring (public browse + private dashboard), and new claim/release flows. No database migrations needed.

**Tech Stack:** FastAPI, Supabase, Next.js 16, React 19, Tailwind CSS v4, shadcn/ui, Space Mono (dot-matrix font)

**Spec:** `docs/superpowers/specs/2026-03-11-auth-redesign-and-public-ui.md`

---

## Chunk 1: Backend — Agent Claim, Release & Dashboard Endpoints

### Task 1: Add Pydantic models for claim/release/overview

**Files:**
- Modify: `app/models/agent.py`

- [ ] **Step 1: Add new request/response models to agent.py**

Add these models after the existing `AgentRegisterResponse` class (after line 116):

```python
class AgentClaimRequest(BaseModel):
    api_key: str

class AgentClaimResponse(BaseModel):
    id: str
    name: str
    username: str | None = None
    api_key_prefix: str
    is_active: bool
    owner_user_id: str
    message: str

class AgentReleaseResponse(BaseModel):
    id: str
    name: str
    username: str | None = None
    message: str

class AgentOverviewAgent(BaseModel):
    id: str
    name: str
    username: str | None = None
    is_active: bool
    last_active_at: str | None = None

class AgentOverviewSession(BaseModel):
    id: str
    short_id: str
    agent_name: str
    topic: str
    status: str
    started_at: str

class AgentOverviewExperience(BaseModel):
    id: str
    short_id: str
    agent_name: str
    goal: str
    status: str
    quality_score: float
    created_at: str

class AgentOverviewStats(BaseModel):
    total_sessions: int
    total_experiences: int
    overall_success_rate: float
    total_upvotes: int

class AgentOverviewResponse(BaseModel):
    agents: list[AgentOverviewAgent]
    recent_sessions: list[AgentOverviewSession]
    recent_experiences: list[AgentOverviewExperience]
    aggregate_stats: AgentOverviewStats
```

- [ ] **Step 2: Commit**

```bash
git add app/models/agent.py
git commit -m "feat: add Pydantic models for claim, release, and dashboard overview"
```

---

### Task 2: Add claim and release methods to AgentRepository

**Files:**
- Modify: `app/repositories/agent_repo.py`

- [ ] **Step 1: Write the failing test for claim_agent**

Add to `tests/test_agents.py`:

```python
class TestAgentClaim:
    """Tests for agent claim and release functionality."""

    def test_claim_agent_success(self, client, auth_headers, mock_supabase, mock_agent):
        """Successfully claim an unclaimed agent."""
        unclaimed_agent = {**mock_agent, "owner_user_id": None, "is_active": True}

        with patch("app.services.agent_service.AgentService.claim_agent") as mock_claim:
            mock_claim.return_value = {**unclaimed_agent, "owner_user_id": "user-123"}
            response = client.post(
                "/api/v1/agents/claim",
                headers=auth_headers,
                json={"api_key": "plrm_live_testkey123456789012345678"}
            )
        assert response.status_code == 200
        data = response.json()
        assert "owner_user_id" in data or "message" in data

    def test_claim_already_claimed_agent(self, client, auth_headers):
        """Reject claiming an already-claimed agent."""
        with patch("app.services.agent_service.AgentService.claim_agent") as mock_claim:
            from app.core.exceptions import DuplicateError
            mock_claim.side_effect = DuplicateError("Agent is already claimed by another account")
            response = client.post(
                "/api/v1/agents/claim",
                headers=auth_headers,
                json={"api_key": "plrm_live_testkey123456789012345678"}
            )
        assert response.status_code == 409

    def test_release_agent_success(self, client, auth_headers, mock_agent):
        """Successfully release a claimed agent."""
        with patch("app.services.agent_service.AgentService.release_agent") as mock_release:
            mock_release.return_value = {**mock_agent, "owner_user_id": None}
            response = client.post(
                f"/api/v1/agents/{mock_agent['id']}/release",
                headers=auth_headers
            )
        assert response.status_code == 200

    def test_release_agent_not_owner(self, client, auth_headers, mock_agent):
        """Reject releasing an agent you don't own."""
        with patch("app.services.agent_service.AgentService.release_agent") as mock_release:
            from app.core.exceptions import AuthorizationError
            mock_release.side_effect = AuthorizationError("You do not own this agent")
            response = client.post(
                f"/api/v1/agents/{mock_agent['id']}/release",
                headers=auth_headers
            )
        assert response.status_code == 403
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/amalfi/Desktop/PLURUM && python -m pytest tests/test_agents.py::TestAgentClaim -v`
Expected: FAIL — endpoints don't exist yet

- [ ] **Step 3: Add repo methods to agent_repo.py**

Add after the `is_username_taken` method (after line 156):

```python
def claim_agent(self, agent_id: UUID, owner_user_id: str) -> dict:
    """Set owner_user_id on an agent (claim it)."""
    return self.update(agent_id, {
        "owner_user_id": owner_user_id,
        "updated_at": "now()",
    })

def release_agent(self, agent_id: UUID) -> dict:
    """Remove owner_user_id from an agent (release it)."""
    result = (
        self.client.table(self.table)
        .update({"owner_user_id": None, "updated_at": "now()"})
        .eq("id", str(agent_id))
        .execute()
    )
    if not result.data:
        raise NotFoundError(f"Agent {agent_id} not found")
    return result.data[0]
```

- [ ] **Step 4: Commit**

```bash
git add app/repositories/agent_repo.py
git commit -m "feat: add claim_agent and release_agent repo methods"
```

---

### Task 3: Add claim and release methods to AgentService

**Files:**
- Modify: `app/services/agent_service.py`

- [ ] **Step 1: Add claim_agent method**

Add after the `deactivate` method (after line 150):

```python
def claim_agent(self, api_key: str, owner_user_id: str) -> dict:
    """Claim an unclaimed agent using its API key."""
    api_key_hash = hash_api_key(api_key)
    agent = self.repo.get_by_api_key_hash(api_key_hash)

    if not agent:
        raise AuthenticationError("Invalid API key")

    if not agent.get("is_active", False):
        from app.core.exceptions import PlurimException
        raise PlurimException("Agent is not active", status_code=400)

    if agent.get("owner_user_id"):
        raise DuplicateError("Agent is already claimed by another account")

    updated = self.repo.claim_agent(UUID(agent["id"]), owner_user_id)
    return updated
```

- [ ] **Step 2: Add release_agent method**

```python
def release_agent(self, agent_id: UUID, owner_user_id: str) -> dict:
    """Release a claimed agent back to unclaimed state."""
    agent = self.repo.get_by_id(agent_id)

    if agent.get("owner_user_id") != owner_user_id:
        raise AuthorizationError("You do not own this agent")

    updated = self.repo.release_agent(agent_id)
    return updated
```

- [ ] **Step 3: Add rotate_key_as_owner method**

```python
def rotate_api_key_as_owner(self, agent_id: UUID, owner_user_id: str) -> dict:
    """Rotate an agent's API key as its human owner."""
    agent = self.repo.get_by_id(agent_id)

    if agent.get("owner_user_id") != owner_user_id:
        raise AuthorizationError("You do not own this agent")

    new_api_key = generate_api_key()
    new_hash = hash_api_key(new_api_key)
    new_prefix = get_api_key_prefix(new_api_key)

    self.repo.update_api_key(agent_id, new_hash, new_prefix)

    return {
        "id": str(agent_id),
        "name": agent["name"],
        "api_key": new_api_key,
        "api_key_prefix": new_prefix,
        "message": "API key rotated successfully. Store this key — it won't be shown again.",
    }
```

- [ ] **Step 4: Add get_overview method**

```python
def get_overview(self, owner_user_id: str) -> dict:
    """Get dashboard overview for a human user's agents."""
    from app.repositories.session_repo import SessionRepository
    from app.repositories.experience_repo import ExperienceRepository

    agents = self.repo.list_by_owner(owner_user_id)
    agent_ids = [a["id"] for a in agents]

    if not agent_ids:
        return {
            "agents": [],
            "recent_sessions": [],
            "recent_experiences": [],
            "aggregate_stats": {
                "total_sessions": 0,
                "total_experiences": 0,
                "overall_success_rate": 0.0,
                "total_upvotes": 0,
            },
        }

    session_repo = SessionRepository()
    experience_repo = ExperienceRepository()

    # Build agent name lookup
    agent_names = {a["id"]: a.get("name", "Unknown") for a in agents}

    # Get recent sessions across all owned agents (and true counts)
    all_sessions = []
    total_session_count = 0
    for aid in agent_ids:
        sessions, count = session_repo.list_by_agent(aid, limit=5)
        total_session_count += count
        for s in sessions:
            s["agent_name"] = agent_names.get(s.get("agent_id", aid), "Unknown")
        all_sessions.extend(sessions)
    all_sessions.sort(key=lambda s: s.get("started_at", ""), reverse=True)
    recent_sessions = all_sessions[:10]

    # Get recent experiences across all owned agents (and true counts)
    all_experiences = []
    total_experience_count = 0
    for aid in agent_ids:
        items, count = experience_repo.list_experiences(agent_id=aid, limit=5)
        total_experience_count += count
        for e in items:
            e["agent_name"] = agent_names.get(e.get("agent_id", aid), "Unknown")
        all_experiences.extend(items)
    all_experiences.sort(key=lambda e: e.get("created_at", ""), reverse=True)
    recent_experiences = all_experiences[:10]

    # Aggregate stats (use true counts, not capped subset)
    total_sessions = total_session_count
    total_experiences = total_experience_count
    success_count = sum(1 for e in all_experiences if e.get("outcome") == "success")
    total_upvotes = sum(e.get("upvotes", 0) for e in all_experiences)
    overall_success_rate = (success_count / total_experiences) if total_experiences > 0 else 0.0

    return {
        "agents": [
            {
                "id": a["id"],
                "name": a["name"],
                "username": a.get("username"),
                "is_active": a.get("is_active", True),
                "last_active_at": a.get("last_active_at"),
            }
            for a in agents
        ],
        "recent_sessions": [
            {
                "id": s["id"],
                "short_id": s.get("short_id", ""),
                "agent_name": s.get("agent_name", "Unknown"),
                "topic": s.get("topic", ""),
                "status": s.get("status", ""),
                "started_at": s.get("started_at", ""),
            }
            for s in recent_sessions
        ],
        "recent_experiences": [
            {
                "id": e["id"],
                "short_id": e.get("short_id", ""),
                "agent_name": e.get("agent_name", "Unknown"),
                "goal": e.get("goal", ""),
                "status": e.get("status", ""),
                "quality_score": e.get("quality_score", 0.0),
                "created_at": e.get("created_at", ""),
            }
            for e in recent_experiences
        ],
        "aggregate_stats": {
            "total_sessions": total_sessions,
            "total_experiences": total_experiences,
            "overall_success_rate": round(overall_success_rate, 4),
            "total_upvotes": total_upvotes,
        },
    }
```

- [ ] **Step 5: Commit**

```bash
git add app/services/agent_service.py
git commit -m "feat: add claim, release, rotate-as-owner, and overview service methods"
```

---

### Task 4: Add route handlers for new endpoints

**Files:**
- Modify: `app/api/v1/agents.py`

- [ ] **Step 1: Add imports for new models**

At line 8 of `app/api/v1/agents.py`, update the import:

```python
from app.models.agent import (
    AgentCreate, AgentUpdate, AgentPublic, AgentRegisterResponse,
    AgentClaimRequest, AgentClaimResponse, AgentReleaseResponse,
    AgentOverviewResponse,
)
```

- [ ] **Step 2: Add claim endpoint**

Add after the `update_agent` route (after line 120):

```python
@router.post("/claim", status_code=status.HTTP_200_OK)
@limiter.limit("10/hour")
async def claim_agent(request: Request, data: AgentClaimRequest, user: CurrentUser):
    """Claim an unclaimed agent using its API key."""
    service = AgentService()
    agent = service.claim_agent(data.api_key, user["id"])
    return {
        "id": agent["id"],
        "name": agent["name"],
        "username": agent.get("username"),
        "api_key_prefix": agent.get("api_key_prefix", ""),
        "is_active": agent.get("is_active", True),
        "owner_user_id": agent.get("owner_user_id"),
        "message": "Agent claimed successfully.",
    }
```

- [ ] **Step 3: Add release endpoint**

```python
@router.post("/{agent_id}/release", status_code=status.HTTP_200_OK)
async def release_agent(agent_id: str, user: CurrentUser):
    """Release a claimed agent back to unclaimed state."""
    service = AgentService()
    from uuid import UUID
    agent = service.release_agent(UUID(agent_id), user["id"])
    return {
        "id": agent["id"],
        "name": agent["name"],
        "username": agent.get("username"),
        "message": "Agent released successfully.",
    }
```

- [ ] **Step 4: Add owner key rotation endpoint**

```python
@router.post("/{agent_id}/rotate-key", status_code=status.HTTP_200_OK)
async def rotate_agent_key_as_owner(agent_id: str, user: CurrentUser):
    """Rotate an agent's API key as its human owner."""
    service = AgentService()
    from uuid import UUID
    result = service.rotate_api_key_as_owner(UUID(agent_id), user["id"])
    return result
```

- [ ] **Step 5: Add dashboard overview endpoint**

```python
@router.get("/me/overview", status_code=status.HTTP_200_OK)
async def get_overview(user: CurrentUser):
    """Get dashboard overview for human user's agents."""
    service = AgentService()
    return service.get_overview(user["id"])
```

**IMPORTANT: Final route order in agents.py must be:**
1. `POST /register` (open)
2. `POST /register/authenticated` (JWT)
3. `GET /me` (API key)
4. `GET /me/agents` (JWT)
5. `GET /me/overview` (JWT) — **must be before any `/{agent_id}` routes**
6. `POST /me/rotate-key` (API key)
7. `POST /claim` (JWT)
8. `PATCH /{agent_id}` (JWT)
9. `POST /{agent_id}/release` (JWT)
10. `POST /{agent_id}/rotate-key` (JWT)

If `/me/overview` is placed after any `/{agent_id}` route, FastAPI will try to match "me" as an agent_id.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/amalfi/Desktop/PLURUM && python -m pytest tests/test_agents.py -v`
Expected: All tests PASS including new TestAgentClaim tests

- [ ] **Step 7: Commit**

```bash
git add app/api/v1/agents.py tests/test_agents.py
git commit -m "feat: add claim, release, rotate-key, and overview API endpoints"
```

---

### Task 5: Make session list and detail publicly accessible

**Files:**
- Modify: `app/api/v1/sessions.py`
- Modify: `app/services/session_service.py`

- [ ] **Step 1: Write the failing test for public session access**

Add to `tests/test_sessions.py`:

```python
class TestPublicSessionAccess:
    """Tests for unauthenticated session browsing."""

    def test_list_public_sessions_no_auth(self, client, mock_supabase):
        """List public sessions without authentication."""
        with patch("app.services.session_service.SessionService.list_public_sessions") as mock_list:
            mock_list.return_value = {"items": [], "total": 0, "limit": 20, "offset": 0, "has_more": False}
            response = client.get("/api/v1/sessions?visibility=public")
        assert response.status_code == 200

    def test_get_public_session_no_auth(self, client, mock_supabase):
        """View a public session without authentication."""
        with patch("app.services.session_service.SessionService.get_public_session") as mock_get:
            mock_get.return_value = {
                "id": "test-id", "short_id": "abc12345", "topic": "test",
                "status": "open", "visibility": "public", "entries": []
            }
            response = client.get("/api/v1/sessions/abc12345")
        assert response.status_code == 200

    def test_get_private_session_no_auth_rejected(self, client, mock_supabase):
        """Cannot view a private session without authentication."""
        with patch("app.services.session_service.SessionService.get_public_session") as mock_get:
            from app.core.exceptions import NotFoundError
            mock_get.side_effect = NotFoundError("Session", "private123")
            response = client.get("/api/v1/sessions/private123")
        assert response.status_code == 404
```

**IMPORTANT:** Also update the existing `TestSessionAuthRequired` tests that will now pass instead of returning 401. Change these:
- `test_list_sessions_no_auth`: expect 200 (not 401) — now returns public sessions
- `test_get_session_no_auth`: expect 200 or 404 (not 401) — depends on session visibility

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/amalfi/Desktop/PLURUM && python -m pytest tests/test_sessions.py::TestPublicSessionAccess -v`
Expected: FAIL — routes require auth

- [ ] **Step 3: Update session routes to use OptionalAgent**

In `app/api/v1/sessions.py`, update the import at line 7:

```python
from app.core.security import CurrentAgent, OptionalAgent
```

Then modify the `list_sessions` route (line 53) and `get_session` route (line 73):

**list_sessions** — change signature from `agent: CurrentAgent` to `agent: OptionalAgent`:

```python
@router.get("", status_code=status.HTTP_200_OK)
async def list_sessions(
    agent: OptionalAgent,
    status_filter: Optional[str] = Query(None, alias="status"),
    visibility: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """List sessions. Public sessions visible to all. Own sessions visible when authenticated."""
    service = SessionService()
    if agent:
        return service.list_sessions(agent["id"], status_filter=status_filter, limit=limit, offset=offset)
    else:
        return service.list_public_sessions(status_filter=status_filter, limit=limit, offset=offset)
```

**get_session** — change signature:

```python
@router.get("/{identifier}", status_code=status.HTTP_200_OK)
async def get_session(identifier: str, agent: OptionalAgent):
    """Get session detail. Public sessions visible to all. Private only to owner."""
    service = SessionService()
    if agent:
        return service.get_session(identifier, agent["id"])
    else:
        return service.get_public_session(identifier)
```

- [ ] **Step 4: Add service methods for public access**

Add to `app/services/session_service.py`:

```python
def list_public_sessions(
    self,
    status_filter: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> dict:
    """List public sessions (no auth required)."""
    return self.repo.list_public(
        status_filter=status_filter,
        limit=limit,
        offset=offset,
    )

def get_public_session(self, identifier: str) -> dict:
    """Get a public session by ID or short_id. Raises NotFoundError for private sessions."""
    if len(identifier) == 8:
        session = self.repo.get_by_short_id(identifier)
    else:
        session = self.repo.get_by_id(identifier)

    if session.get("visibility") == "private":
        raise NotFoundError("Session", identifier)

    entries = self.repo.list_entries(session["id"])
    session["entries"] = entries
    return session
```

- [ ] **Step 5: Add repo method for listing public sessions**

Add to `app/repositories/session_repo.py`:

```python
def list_public(
    self,
    status_filter: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> dict:
    """List public sessions."""
    query = (
        self.client.table("sessions")
        .select("*", count="exact")
        .eq("visibility", "public")
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
    )
    if status_filter:
        query = query.eq("status", status_filter)
    result = query.execute()
    return {
        "items": result.data or [],
        "total": result.count or 0,
        "limit": limit,
        "offset": offset,
        "has_more": (result.count or 0) > offset + limit,
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/amalfi/Desktop/PLURUM && python -m pytest tests/test_sessions.py -v`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add app/api/v1/sessions.py app/services/session_service.py app/repositories/session_repo.py tests/test_sessions.py
git commit -m "feat: make session list and detail publicly accessible for public sessions"
```

---

## Chunk 2: Frontend — Design System Foundation

### Task 6: Install dot-matrix font and update Tailwind theme

**Files:**
- Modify: `web/src/app/layout.tsx`
- Modify: `web/src/app/globals.css`

- [ ] **Step 1: Install Space Mono font**

Add Space Mono import to `web/src/app/layout.tsx`. Update the font imports (currently only Inter):

```typescript
import { Inter, Space_Mono } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const spaceMono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-space-mono",
});
```

Update the `<body>` className to include both font variables:

```tsx
<body className={`${inter.variable} ${spaceMono.variable} font-sans antialiased`}>
```

- [ ] **Step 2: Replace CSS variables with monochrome palette**

Replace the entire `:root` color block in `web/src/app/globals.css` (lines 52-95) with:

```css
:root {
  --background: #FAFAFA;
  --foreground: #0A0A0A;
  --card: #FFFFFF;
  --card-foreground: #0A0A0A;
  --popover: #FFFFFF;
  --popover-foreground: #0A0A0A;
  --primary: #0A0A0A;
  --primary-foreground: #FAFAFA;
  --secondary: #F5F5F5;
  --secondary-foreground: #0A0A0A;
  --muted: #F5F5F5;
  --muted-foreground: #737373;
  --accent: #F5F5F5;
  --accent-foreground: #0A0A0A;
  --destructive: #7F1D1D;
  --destructive-foreground: #FAFAFA;
  --border: #E5E5E5;
  --input: #E5E5E5;
  --ring: #0A0A0A;
  --radius: 2px;

  /* PLURUM-specific tokens */
  --plurum-red: #D71921;
  --plurum-red-muted: #FEE2E2;
  --plurum-border-strong: #D4D4D4;
  --plurum-text-secondary: #737373;
  --plurum-text-tertiary: #A3A3A3;

  /* Spacing scale (4px base) */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --space-2xl: 48px;
  --space-3xl: 64px;
  --space-4xl: 96px;

  /* Chart colors (monochrome) */
  --chart-1: #0A0A0A;
  --chart-2: #404040;
  --chart-3: #737373;
  --chart-4: #A3A3A3;
  --chart-5: #D4D4D4;

  /* Sidebar (monochrome) */
  --sidebar-background: #FAFAFA;
  --sidebar-foreground: #0A0A0A;
  --sidebar-primary: #0A0A0A;
  --sidebar-primary-foreground: #FAFAFA;
  --sidebar-accent: #F5F5F5;
  --sidebar-accent-foreground: #0A0A0A;
  --sidebar-border: #E5E5E5;
  --sidebar-ring: #0A0A0A;
}
```

- [ ] **Step 3: Replace dark mode colors**

Replace the `.dark` block (lines 101-142) with:

```css
.dark {
  --background: #0A0A0A;
  --foreground: #FAFAFA;
  --card: #171717;
  --card-foreground: #FAFAFA;
  --popover: #171717;
  --popover-foreground: #FAFAFA;
  --primary: #FAFAFA;
  --primary-foreground: #0A0A0A;
  --secondary: #262626;
  --secondary-foreground: #FAFAFA;
  --muted: #262626;
  --muted-foreground: #A3A3A3;
  --accent: #262626;
  --accent-foreground: #FAFAFA;
  --destructive: #DC2626;
  --destructive-foreground: #FAFAFA;
  --border: #262626;
  --input: #262626;
  --ring: #FAFAFA;

  --plurum-red: #FF3B3B;
  --plurum-red-muted: #450A0A;
  --plurum-border-strong: #404040;
  --plurum-text-secondary: #A3A3A3;
  --plurum-text-tertiary: #737373;

  --chart-1: #FAFAFA;
  --chart-2: #D4D4D4;
  --chart-3: #A3A3A3;
  --chart-4: #737373;
  --chart-5: #404040;

  --sidebar-background: #0A0A0A;
  --sidebar-foreground: #FAFAFA;
  --sidebar-primary: #FAFAFA;
  --sidebar-primary-foreground: #0A0A0A;
  --sidebar-accent: #262626;
  --sidebar-accent-foreground: #FAFAFA;
  --sidebar-border: #262626;
  --sidebar-ring: #FAFAFA;
}
```

- [ ] **Step 4: Replace custom CSS classes**

Remove all the gradient/glass/glow classes (lines 143-441). Replace with Nothing-inspired utility classes:

```css
/* ============================================
   PLURUM Design System — Nothing-inspired
   ============================================ */

/* Typography */
.font-display {
  font-family: var(--font-space-mono), monospace;
}

.text-label {
  font-family: var(--font-space-mono), monospace;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--plurum-text-tertiary);
}

/* Live indicator — Nothing-style breathing red dot */
.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--plurum-red);
  animation: breathe 2s ease-in-out infinite;
}

@keyframes breathe {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

/* Card with sharp edges, 1px border, no shadow */
.card-sharp {
  border: 1px solid var(--border);
  border-radius: 2px;
  background: var(--card);
}

.card-sharp:hover {
  border-color: var(--plurum-border-strong);
}

/* Subtle fade-in animation */
@keyframes fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.animate-fade-in {
  animation: fade-in 200ms ease-out forwards;
}

/* Staggered children */
.stagger-children > * {
  opacity: 0;
  animation: fade-in 200ms ease-out forwards;
}
.stagger-children > *:nth-child(1) { animation-delay: 0ms; }
.stagger-children > *:nth-child(2) { animation-delay: 50ms; }
.stagger-children > *:nth-child(3) { animation-delay: 100ms; }
.stagger-children > *:nth-child(4) { animation-delay: 150ms; }
.stagger-children > *:nth-child(5) { animation-delay: 200ms; }
.stagger-children > *:nth-child(6) { animation-delay: 250ms; }

/* Dot grid pattern (Nothing-inspired) */
.dot-grid {
  background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
  background-size: 24px 24px;
}

/* Selection colors */
::selection {
  background-color: var(--plurum-red);
  color: white;
}

/* Scrollbar */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 0;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--plurum-border-strong);
}
```

- [ ] **Step 5: Verify the build compiles**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`
Expected: Build succeeds (may have warnings from components still using old classes — that's OK, we'll fix those next)

- [ ] **Step 6: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/app/layout.tsx web/src/app/globals.css
git commit -m "feat: replace design system with Nothing-inspired monochrome palette and dot-matrix font"
```

---

### Task 7: Update shadcn/ui component overrides for monochrome aesthetic

**Files:**
- Modify: `web/components.json`
- Modify: `web/src/components/ui/button.tsx`
- Modify: `web/src/components/ui/card.tsx`
- Modify: `web/src/components/ui/badge.tsx`
- Modify: `web/src/components/ui/input.tsx`

- [ ] **Step 1: Update components.json radius**

In `web/components.json`, change the CSS variable for radius. The key setting is the `--radius` value which we already set to `2px` in globals.css. Verify `components.json` doesn't override it.

- [ ] **Step 2: Update button variants**

Read `web/src/components/ui/button.tsx` and update the variant styles to match the monochrome aesthetic:

- `default`: black fill, white text (`bg-primary text-primary-foreground`)
- `destructive`: dark red (`bg-destructive text-destructive-foreground`)
- `outline`: 1px border, no fill (`border border-input bg-transparent`)
- `secondary`: light gray fill
- `ghost`: transparent, hover gray
- `link`: underline

These should mostly work with the new CSS vars. Verify and adjust if needed.

- [ ] **Step 3: Update card component**

Ensure card uses sharp corners (2px via --radius) and 1px border. The CSS vars should handle this automatically since we set `--radius: 2px`.

- [ ] **Step 4: Update badge for dot-matrix labels**

Read `web/src/components/ui/badge.tsx` and add a `dot-matrix` variant:

Add a new variant to the badge variants:

```typescript
"dot-matrix": "font-display text-[0.6875rem] tracking-wider uppercase border border-border bg-transparent text-foreground",
```

- [ ] **Step 5: Build and verify**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/components/ui/ web/components.json
git commit -m "feat: update shadcn components for monochrome sharp-edge aesthetic"
```

---

## Chunk 3: Frontend — Route Restructuring & Middleware

### Task 8: Update middleware for new route structure

**Files:**
- Modify: `web/src/middleware.ts`

- [ ] **Step 1: Update protected routes and redirects**

Replace the middleware content to reflect the new route structure:

```typescript
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Only dashboard routes require authentication
const protectedPaths = ["/dashboard"];

// Legacy redirects
const legacyRedirects: Record<string, string> = {
  "/overview": "/dashboard",
  "/blueprints": "/experiences",
  "/discussions": "/",
  "/api-keys": "/dashboard/agents",
  "/settings": "/dashboard/settings",
  "/agents/me": "/dashboard/agents",
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Handle legacy redirects first
  for (const [from, to] of Object.entries(legacyRedirects)) {
    if (pathname === from || pathname.startsWith(from + "/")) {
      const url = request.nextUrl.clone();
      url.pathname = to;
      return NextResponse.redirect(url);
    }
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isProtected = protectedPaths.some(
    (path) => pathname === path || pathname.startsWith(path + "/")
  );

  // Redirect unauthenticated users away from protected routes
  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Redirect logged-in users away from login page
  if (pathname === "/login" && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/login",
    "/overview/:path*",
    "/overview",
    "/blueprints/:path*",
    "/blueprints",
    "/discussions/:path*",
    "/discussions",
    "/api-keys/:path*",
    "/api-keys",
    "/settings/:path*",
    "/settings",
    "/agents/me/:path*",
    "/agents/me",
  ],
};
```

- [ ] **Step 2: Update login page redirect target**

In `web/src/app/login/page.tsx`, change the redirect on line 31-32 from `/overview` to `/dashboard`:

```typescript
router.push("/dashboard");
```

- [ ] **Step 3: Update signup page redirect target**

Check `web/src/app/signup/page.tsx` and update any redirect from `/overview` to `/dashboard`.

- [ ] **Step 4: Build and verify**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/middleware.ts web/src/app/login/page.tsx web/src/app/signup/page.tsx
git commit -m "feat: update middleware for public routes and dashboard-only auth"
```

---

### Task 9: Create dashboard route group and move private pages

**Files:**
- Create: `web/src/app/dashboard/layout.tsx`
- Create: `web/src/app/dashboard/page.tsx`
- Create: `web/src/app/dashboard/agents/page.tsx`
- Create: `web/src/app/dashboard/settings/page.tsx`

- [ ] **Step 1: Create dashboard layout**

```typescript
// web/src/app/dashboard/layout.tsx
import { TopNav } from "@/components/layout";
import { SiteFooter } from "@/components/layout";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <TopNav />
      <main className="min-h-screen pt-16 pb-[var(--space-3xl)]">
        <div className="mx-auto max-w-5xl px-[var(--space-xl)]">
          {children}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
```

- [ ] **Step 2: Create dashboard overview page**

This page calls `GET /agents/me/overview` and renders the human's agents + recent activity.

```typescript
// web/src/app/dashboard/page.tsx
"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api/client";
import Link from "next/link";

interface OverviewData {
  agents: Array<{ id: string; name: string; username: string | null; is_active: boolean; last_active_at: string | null }>;
  recent_sessions: Array<{ id: string; short_id: string; agent_name: string; topic: string; status: string; started_at: string }>;
  recent_experiences: Array<{ id: string; short_id: string; agent_name: string; goal: string; status: string; quality_score: number; created_at: string }>;
  aggregate_stats: { total_sessions: number; total_experiences: number; overall_success_rate: number; total_upvotes: number };
}

export default function DashboardPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.get<OverviewData>("/api/v1/agents/me/overview")
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="py-[var(--space-3xl)]">
        <p className="text-label">Loading...</p>
      </div>
    );
  }

  if (!data || data.agents.length === 0) {
    return (
      <div className="py-[var(--space-3xl)]">
        <h1 className="font-display text-2xl font-bold mb-[var(--space-md)]">Dashboard</h1>
        <div className="card-sharp p-[var(--space-lg)]">
          <p className="text-[var(--plurum-text-secondary)] mb-[var(--space-md)]">
            No agents yet. Create one or claim an existing agent.
          </p>
          <Link href="/dashboard/agents" className="font-display text-sm underline">
            Manage Agents →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="py-[var(--space-2xl)]">
      <h1 className="font-display text-2xl font-bold mb-[var(--space-xl)]">Dashboard</h1>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-[var(--space-md)] mb-[var(--space-xl)]">
        {[
          { label: "Agents", value: data.agents.length },
          { label: "Sessions", value: data.aggregate_stats.total_sessions },
          { label: "Experiences", value: data.aggregate_stats.total_experiences },
          { label: "Upvotes", value: data.aggregate_stats.total_upvotes },
        ].map((stat) => (
          <div key={stat.label} className="card-sharp p-[var(--space-lg)]">
            <p className="text-label mb-[var(--space-xs)]">{stat.label}</p>
            <p className="font-display text-2xl font-bold">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Recent Sessions */}
      <section className="mb-[var(--space-xl)]">
        <h2 className="text-label mb-[var(--space-md)]">Recent Sessions</h2>
        <div className="space-y-[var(--space-xs)]">
          {data.recent_sessions.map((session) => (
            <Link
              key={session.id}
              href={`/sessions/${session.short_id}`}
              className="card-sharp p-[var(--space-md)] flex items-center justify-between"
            >
              <div>
                <p className="font-medium">{session.topic}</p>
                <p className="text-sm text-[var(--plurum-text-secondary)]">{session.agent_name}</p>
              </div>
              <span className="text-label">{session.status}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Recent Experiences */}
      <section>
        <h2 className="text-label mb-[var(--space-md)]">Recent Experiences</h2>
        <div className="space-y-[var(--space-xs)]">
          {data.recent_experiences.map((exp) => (
            <Link
              key={exp.id}
              href={`/experiences/${exp.short_id}`}
              className="card-sharp p-[var(--space-md)] flex items-center justify-between"
            >
              <div>
                <p className="font-medium">{exp.goal}</p>
                <p className="text-sm text-[var(--plurum-text-secondary)]">{exp.agent_name}</p>
              </div>
              <span className="text-label">{exp.status}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Create dashboard agents page with claim flow**

This is the key page — list owned agents + claim/release/create functionality.

```typescript
// web/src/app/dashboard/agents/page.tsx
"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api/client";
import { getMyAgents, registerAgentAuthenticated } from "@/lib/api";
import type { Agent, AgentRegisterResponse } from "@/types";
import { toast } from "sonner";

export default function DashboardAgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [claimKey, setClaimKey] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createUsername, setCreateUsername] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);

  const loadAgents = async () => {
    try {
      const data = await getMyAgents();
      setAgents(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAgents(); }, []);

  const handleClaim = async () => {
    if (!claimKey.trim()) return;
    setClaiming(true);
    try {
      await apiClient.post("/api/v1/agents/claim", { api_key: claimKey.trim() });
      toast.success("Agent claimed successfully");
      setClaimKey("");
      loadAgents();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to claim agent";
      toast.error(message);
    } finally {
      setClaiming(false);
    }
  };

  const handleRelease = async (agentId: string) => {
    try {
      await apiClient.post(`/api/v1/agents/${agentId}/release`);
      toast.success("Agent released");
      loadAgents();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to release agent";
      toast.error(message);
    }
  };

  const handleRotateKey = async (agentId: string) => {
    try {
      const result = await apiClient.post<AgentRegisterResponse>(`/api/v1/agents/${agentId}/rotate-key`);
      if (result) {
        setNewKey(result.api_key);
        toast.success("API key rotated");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to rotate key";
      toast.error(message);
    }
  };

  const handleCreate = async () => {
    if (!createName.trim() || !createUsername.trim()) return;
    try {
      const result = await registerAgentAuthenticated({ name: createName, username: createUsername });
      setNewKey(result.api_key);
      setShowCreate(false);
      setCreateName("");
      setCreateUsername("");
      toast.success("Agent created");
      loadAgents();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create agent";
      toast.error(message);
    }
  };

  if (loading) {
    return <div className="py-[var(--space-3xl)]"><p className="text-label">Loading...</p></div>;
  }

  return (
    <div className="py-[var(--space-2xl)]">
      <div className="flex items-center justify-between mb-[var(--space-xl)]">
        <h1 className="font-display text-2xl font-bold">Agents</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="font-display text-sm px-[var(--space-md)] py-[var(--space-sm)] bg-primary text-primary-foreground"
        >
          {showCreate ? "Cancel" : "Create Agent"}
        </button>
      </div>

      {/* New key display */}
      {newKey && (
        <div className="card-sharp border-[var(--plurum-red)] p-[var(--space-lg)] mb-[var(--space-lg)]">
          <p className="text-label text-[var(--plurum-red)] mb-[var(--space-sm)]">New API Key — Copy Now</p>
          <code className="font-display text-sm break-all select-all">{newKey}</code>
          <p className="text-sm text-[var(--plurum-text-secondary)] mt-[var(--space-sm)]">
            This key will not be shown again.
          </p>
          <button
            onClick={() => setNewKey(null)}
            className="text-label mt-[var(--space-md)] underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Create agent form */}
      {showCreate && (
        <div className="card-sharp p-[var(--space-lg)] mb-[var(--space-lg)]">
          <p className="text-label mb-[var(--space-md)]">Create New Agent</p>
          <div className="space-y-[var(--space-md)]">
            <input
              type="text"
              placeholder="Agent name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              className="w-full border border-input bg-transparent px-[var(--space-md)] py-[var(--space-sm)] text-sm focus:border-foreground outline-none"
            />
            <input
              type="text"
              placeholder="Username (lowercase, no spaces)"
              value={createUsername}
              onChange={(e) => setCreateUsername(e.target.value)}
              className="w-full border border-input bg-transparent px-[var(--space-md)] py-[var(--space-sm)] text-sm focus:border-foreground outline-none"
            />
            <button onClick={handleCreate} className="font-display text-sm px-[var(--space-md)] py-[var(--space-sm)] bg-primary text-primary-foreground">
              Create
            </button>
          </div>
        </div>
      )}

      {/* Claim agent */}
      <div className="card-sharp p-[var(--space-lg)] mb-[var(--space-xl)]">
        <p className="text-label mb-[var(--space-md)]">Claim Existing Agent</p>
        <div className="flex gap-[var(--space-sm)]">
          <input
            type="text"
            placeholder="Paste API key (plrm_live_...)"
            value={claimKey}
            onChange={(e) => setClaimKey(e.target.value)}
            className="flex-1 border border-input bg-transparent px-[var(--space-md)] py-[var(--space-sm)] text-sm font-display focus:border-foreground outline-none"
          />
          <button
            onClick={handleClaim}
            disabled={claiming || !claimKey.trim()}
            className="font-display text-sm px-[var(--space-md)] py-[var(--space-sm)] bg-primary text-primary-foreground disabled:opacity-50"
          >
            {claiming ? "Claiming..." : "Claim"}
          </button>
        </div>
      </div>

      {/* Agent list */}
      <div className="space-y-[var(--space-sm)]">
        {agents.length === 0 ? (
          <p className="text-[var(--plurum-text-secondary)]">No agents yet.</p>
        ) : (
          agents.map((agent) => (
            <div key={agent.id} className="card-sharp p-[var(--space-lg)] flex items-center justify-between">
              <div>
                <p className="font-medium">{agent.name}</p>
                <p className="text-sm text-[var(--plurum-text-secondary)]">
                  @{agent.username || "no-username"} · {agent.api_key_prefix}
                </p>
              </div>
              <div className="flex gap-[var(--space-sm)]">
                <button
                  onClick={() => handleRotateKey(agent.id)}
                  className="text-label hover:text-foreground"
                >
                  Rotate Key
                </button>
                <button
                  onClick={() => handleRelease(agent.id)}
                  className="text-label text-[var(--destructive)] hover:underline"
                >
                  Release
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create dashboard settings page**

Move settings from `(platform)/settings` to `dashboard/settings`:

```typescript
// web/src/app/dashboard/settings/page.tsx
"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export default function SettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleSignOut = async () => {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    toast.success("Signed out");
    router.push("/");
  };

  return (
    <div className="py-[var(--space-2xl)]">
      <h1 className="font-display text-2xl font-bold mb-[var(--space-xl)]">Settings</h1>

      <div className="card-sharp p-[var(--space-lg)]">
        <p className="text-label mb-[var(--space-md)]">Account</p>
        <button
          onClick={handleSignOut}
          disabled={loading}
          className="font-display text-sm px-[var(--space-md)] py-[var(--space-sm)] bg-[var(--destructive)] text-[var(--destructive-foreground)]"
        >
          {loading ? "Signing out..." : "Sign Out"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build and verify**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/app/dashboard/
git commit -m "feat: create dashboard route group with overview, agents, and settings pages"
```

---

## Chunk 4: Frontend — Public Pages

### Task 10: Make experiences and sessions pages public

**Files:**
- Move: `web/src/app/(platform)/experiences/` → `web/src/app/experiences/`
- Move: `web/src/app/(platform)/sessions/` → `web/src/app/sessions/`
- Create: `web/src/app/experiences/layout.tsx`
- Create: `web/src/app/sessions/layout.tsx`

- [ ] **Step 1: Move experiences out of (platform) group**

```bash
cd /Users/amalfi/Desktop/PLURUM/web/src/app
mv "(platform)/experiences" ./experiences
```

- [ ] **Step 2: Create public layout for experiences**

```typescript
// web/src/app/experiences/layout.tsx
import { TopNav } from "@/components/layout";
import { SiteFooter } from "@/components/layout";

export default function ExperiencesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <TopNav />
      <main className="min-h-screen pt-16 pb-[var(--space-3xl)]">
        <div className="mx-auto max-w-5xl px-[var(--space-xl)]">
          {children}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
```

- [ ] **Step 3: Update experiences pages to use monochrome design**

Update `web/src/app/experiences/page.tsx` — strip any gradient/glass classes, use `card-sharp`, `font-display`, `text-label`, monochrome colors. Remove any auth-dependent logic (these are now public).

Update `web/src/app/experiences/[identifier]/page.tsx` — same treatment.

Update `web/src/app/experiences/search/page.tsx` — same treatment.

- [ ] **Step 4: Move sessions out of (platform) group**

```bash
cd /Users/amalfi/Desktop/PLURUM/web/src/app
mv "(platform)/sessions" ./sessions
```

- [ ] **Step 5: Create public layout for sessions**

```typescript
// web/src/app/sessions/layout.tsx
import { TopNav } from "@/components/layout";
import { SiteFooter } from "@/components/layout";

export default function SessionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <TopNav />
      <main className="min-h-screen pt-16 pb-[var(--space-3xl)]">
        <div className="mx-auto max-w-5xl px-[var(--space-xl)]">
          {children}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
```

- [ ] **Step 6: Update sessions list page for public browsing**

The sessions list page currently calls `listSessions()` which requires auth. Update it to call the public endpoint (same URL, but no auth header when browsing publicly). The API client already adds auth if available, and the backend now returns public sessions without auth.

- [ ] **Step 7: Build and verify**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/app/experiences/ web/src/app/sessions/
git commit -m "feat: move experiences and sessions to public routes with monochrome design"
```

---

### Task 11: Make agent profiles public

**Files:**
- Move: `web/src/app/(platform)/agents/[agentId]/` → `web/src/app/agents/[agentId]/`
- Create: `web/src/app/agents/layout.tsx`

- [ ] **Step 1: Create agents layout**

```typescript
// web/src/app/agents/layout.tsx
import { TopNav } from "@/components/layout";
import { SiteFooter } from "@/components/layout";

export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <TopNav />
      <main className="min-h-screen pt-16 pb-[var(--space-3xl)]">
        <div className="mx-auto max-w-5xl px-[var(--space-xl)]">
          {children}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
```

- [ ] **Step 2: Move agent profile page**

```bash
cd /Users/amalfi/Desktop/PLURUM/web/src/app
mkdir -p agents
mv "(platform)/agents/[agentId]" agents/
```

- [ ] **Step 3: Update agent profile page for public access**

Update the page to use `getAgentProfile` (already exists, already public endpoint). Apply monochrome design — `card-sharp`, `font-display`, `text-label` classes.

- [ ] **Step 4: Update agent components for monochrome**

Update these components to use the new design tokens:
- `web/src/components/agents/agent-profile-header.tsx`
- `web/src/components/agents/agent-stats-cards.tsx`
- `web/src/components/agents/contribution-graph.tsx`
- `web/src/components/agents/top-experiences-list.tsx`

Replace any gradient/glass/oklch references with monochrome design tokens.

- [ ] **Step 5: Build and verify**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`

- [ ] **Step 6: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/app/agents/ web/src/components/agents/
git commit -m "feat: make agent profiles public with monochrome design"
```

---

### Task 12: Redesign landing page

**Files:**
- Modify: `web/src/components/landing/hero-section.tsx`
- Modify: `web/src/components/landing/landing-page.tsx`
- Modify: `web/src/components/landing/hero-background.tsx`
- Modify: `web/src/components/landing/install-section.tsx`
- Modify: `web/src/components/landing/primitives-section.tsx`
- Modify: `web/src/components/landing/cta-section.tsx`

- [ ] **Step 1: Redesign hero section**

Replace the current cinematic gradient hero with a Nothing-inspired monochrome hero:

- Dot-matrix headline using `font-display` (Space Mono)
- Live pulse counter (red breathing dot + count of active sessions)
- Minimal CTA button (black fill)
- Dot-grid background instead of gradient
- Maximum negative space

Read the current `hero-section.tsx` and rewrite it with the new aesthetic. Keep the same component interface.

- [ ] **Step 2: Replace hero background**

Replace `hero-background.tsx` — remove all gradient/glow/orb animations. Replace with subtle dot-grid pattern:

```tsx
export function HeroBackground() {
  return (
    <div className="absolute inset-0 dot-grid opacity-40" aria-hidden="true" />
  );
}
```

- [ ] **Step 3: Redesign install section**

Update `install-section.tsx` — use `font-display` for the code blocks, sharp-edge cards, monochrome palette. Keep the installation instructions content but restyle completely.

- [ ] **Step 4: Redesign primitives section**

Update `primitives-section.tsx` — showcase PLURUM's core concepts (sessions, experiences, pulse) with monochrome cards, dot-matrix labels, minimal icons.

- [ ] **Step 5: Redesign CTA section**

Update `cta-section.tsx` — simple monochrome CTA. Dot-matrix headline, single black button, lots of white space.

- [ ] **Step 6: Update landing-page.tsx**

Remove `SmoothScrollProvider` if using heavy animation deps. Use simple CSS `animate-fade-in` instead. Update `LandingPage` to compose the new sections.

- [ ] **Step 7: Build and verify**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`

- [ ] **Step 8: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/components/landing/
git commit -m "feat: redesign landing page with Nothing-inspired monochrome aesthetic"
```

---

### Task 13: Redesign navigation (TopNav) and footer

**Files:**
- Modify: `web/src/components/layout/top-nav.tsx`
- Modify: `web/src/components/layout/site-footer.tsx`

- [ ] **Step 1: Redesign TopNav**

Read the current `top-nav.tsx` (259 lines) and rewrite with:
- Thin, monochrome top bar
- `font-display` for logo/brand
- Navigation links: Experiences, Sessions, Pulse, Docs (always visible, public)
- Auth section: Login/Signup if not logged in, Dashboard link if logged in
- No colors, no backgrounds — just type and a 1px bottom border
- Live indicator (breathing red dot) if pulse is active

- [ ] **Step 2: Redesign SiteFooter**

Read the current `site-footer.tsx` (102 lines) and rewrite with:
- Minimal monochrome footer
- `font-display` for brand name
- Links: GitHub, Docs, API Reference
- `text-label` for copyright

- [ ] **Step 3: Build and verify**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`

- [ ] **Step 4: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/components/layout/
git commit -m "feat: redesign navigation and footer with monochrome aesthetic"
```

---

## Chunk 5: Frontend — Pulse, Docs, Auth Pages & Cleanup

### Task 14: Make pulse page public and redesign

**Files:**
- Move: `web/src/app/(platform)/pulse/` → `web/src/app/pulse/`
- Create: `web/src/app/pulse/layout.tsx`

- [ ] **Step 1: Move pulse out of (platform)**

```bash
cd /Users/amalfi/Desktop/PLURUM/web/src/app
mv "(platform)/pulse" ./pulse
```

- [ ] **Step 2: Create pulse layout (same pattern as other public routes)**

- [ ] **Step 3: Restyle pulse page with monochrome design**

Use live-dot indicators, card-sharp for activity entries, font-display for timestamps, text-label for metadata.

- [ ] **Step 4: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/app/pulse/
git commit -m "feat: make pulse page public with monochrome design"
```

---

### Task 15: Move docs to public routes

**Files:**
- Move: `web/src/app/(platform)/docs/` → `web/src/app/docs/`

- [ ] **Step 1: Move docs out of (platform)**

```bash
cd /Users/amalfi/Desktop/PLURUM/web/src/app
mv "(platform)/docs" ./docs
```

- [ ] **Step 2: Create docs layout**

Same public layout pattern with TopNav and SiteFooter.

- [ ] **Step 3: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/app/docs/
git commit -m "feat: make docs pages public"
```

---

### Task 16: Redesign auth pages (login, signup)

**Files:**
- Modify: `web/src/app/login/page.tsx`
- Modify: `web/src/app/signup/page.tsx`
- Modify: `web/src/app/forgot-password/page.tsx`
- Modify: `web/src/app/reset-password/page.tsx`

- [ ] **Step 1: Redesign login page**

Restyle with monochrome aesthetic:
- Centered card-sharp form
- font-display for heading
- Thin-border inputs with focus:border-foreground
- Black primary button
- Dot-grid background

- [ ] **Step 2: Redesign signup page**

Same treatment as login.

- [ ] **Step 3: Redesign forgot/reset password pages**

Same treatment.

- [ ] **Step 4: Build and verify**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`

- [ ] **Step 5: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/app/login/ web/src/app/signup/ web/src/app/forgot-password/ web/src/app/reset-password/
git commit -m "feat: redesign auth pages with monochrome aesthetic"
```

---

### Task 17: Remove old (platform) route group

**Files:**
- Delete: `web/src/app/(platform)/` (entire directory)

- [ ] **Step 1: Verify all pages have been moved**

Check that these exist:
- `web/src/app/experiences/` (public)
- `web/src/app/sessions/` (public)
- `web/src/app/agents/` (public)
- `web/src/app/pulse/` (public)
- `web/src/app/docs/` (public)
- `web/src/app/dashboard/` (private)

- [ ] **Step 2: Remove the old (platform) directory**

```bash
rm -rf /Users/amalfi/Desktop/PLURUM/web/src/app/\(platform\)/
```

- [ ] **Step 3: Build and verify clean build**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`
Expected: Build succeeds with zero errors

- [ ] **Step 4: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add -A web/src/app/
git commit -m "chore: remove old (platform) route group — all pages migrated"
```

---

## Chunk 6: Frontend API Client Updates & Final Integration

### Task 18: Add claim/release/overview to frontend API client

**Files:**
- Modify: `web/src/lib/api/agents.ts`
- Modify: `web/src/types/agent.ts`

- [ ] **Step 1: Add new types**

Add to `web/src/types/agent.ts`:

```typescript
export interface AgentClaimRequest {
  api_key: string;
}

export interface AgentOverview {
  agents: Array<{
    id: string;
    name: string;
    username: string | null;
    is_active: boolean;
    last_active_at: string | null;
  }>;
  recent_sessions: Array<{
    id: string;
    short_id: string;
    agent_name: string;
    topic: string;
    status: string;
    started_at: string;
  }>;
  recent_experiences: Array<{
    id: string;
    short_id: string;
    agent_name: string;
    goal: string;
    status: string;
    quality_score: number;
    created_at: string;
  }>;
  aggregate_stats: {
    total_sessions: number;
    total_experiences: number;
    overall_success_rate: number;
    total_upvotes: number;
  };
}
```

- [ ] **Step 2: Add API functions**

Add to `web/src/lib/api/agents.ts`:

```typescript
export async function registerAgentAuthenticated(data: AgentCreate): Promise<AgentRegisterResponse> {
  return apiClient.post<AgentRegisterResponse>("/api/v1/agents/register/authenticated", data);
}

export async function claimAgent(apiKey: string): Promise<unknown> {
  return apiClient.post("/api/v1/agents/claim", { api_key: apiKey });
}

export async function releaseAgent(agentId: string): Promise<unknown> {
  return apiClient.post(`/api/v1/agents/${agentId}/release`);
}

export async function rotateAgentKey(agentId: string): Promise<AgentRegisterResponse> {
  return apiClient.post<AgentRegisterResponse>(`/api/v1/agents/${agentId}/rotate-key`);
}

export async function getDashboardOverview(): Promise<AgentOverview> {
  return apiClient.get<AgentOverview>("/api/v1/agents/me/overview");
}
```

- [ ] **Step 3: Update index.ts exports**

Add the new functions to `web/src/lib/api/index.ts` exports.

- [ ] **Step 4: Commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add web/src/lib/api/ web/src/types/
git commit -m "feat: add claim, release, overview API client functions and types"
```

---

### Task 19: Final build verification and cleanup

**Files:**
- Various cleanup across all modified files

- [ ] **Step 1: Full build test**

Run: `cd /Users/amalfi/Desktop/PLURUM/web && npx next build`
Expected: Clean build with zero errors

- [ ] **Step 2: Run backend tests**

Run: `cd /Users/amalfi/Desktop/PLURUM && python -m pytest tests/ -v`
Expected: All tests pass

- [ ] **Step 3: Verify key user flows**

Manual verification checklist:
- [ ] Landing page loads without auth
- [ ] `/experiences` lists public experiences without login
- [ ] `/sessions` lists public sessions without login
- [ ] `/agents/{id}` shows public agent profile
- [ ] `/login` → `/dashboard` redirect works
- [ ] `/dashboard` shows agent overview (auth required)
- [ ] `/dashboard/agents` shows claim flow
- [ ] `/overview` redirects to `/dashboard` (backward compat)
- [ ] `/blueprints` redirects to `/experiences` (backward compat)

- [ ] **Step 4: Clean up any unused imports or dead code**

Search for any remaining references to old routes, gradient classes, or glass-card styles.

- [ ] **Step 5: Final commit**

```bash
cd /Users/amalfi/Desktop/PLURUM
git add -A
git commit -m "chore: final cleanup — remove unused imports and dead code"
```

---

## Task Summary

| Chunk | Tasks | Focus |
|-------|-------|-------|
| 1 | Tasks 1-5 | Backend: models, repo, service, routes, public session access |
| 2 | Tasks 6-7 | Design system: fonts, colors, CSS vars, component overrides |
| 3 | Tasks 8-9 | Route restructuring: middleware, dashboard pages |
| 4 | Tasks 10-13 | Public pages: experiences, sessions, agents, landing page |
| 5 | Tasks 14-17 | Pulse, docs, auth pages, old route cleanup |
| 6 | Tasks 18-19 | API client updates, final integration and verification |

**Total: 19 tasks across 6 chunks**

**Dependencies:**
- Chunk 1 (backend) can run independently
- Chunk 2 (design system) can run independently
- Chunk 3 depends on Chunk 2 (needs new CSS vars)
- Chunk 4 depends on Chunks 2 + 3 (needs design system + new routes)
- Chunk 5 depends on Chunks 2 + 3
- Chunk 6 depends on Chunks 1 + 3 + 4

**Parallelization:** Chunks 1 and 2 can run in parallel. Chunks 4 and 5 can run in parallel after Chunk 3.
