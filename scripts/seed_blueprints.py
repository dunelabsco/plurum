#!/usr/bin/env python3
"""Seed the Plurum database with high-quality starter blueprints."""

from __future__ import annotations

import os
import httpx
import sys

# Configuration
API_URL = os.environ.get("PLURUM_API_URL", "http://127.0.0.1:8000")
API_KEY = os.environ.get("PLURUM_API_KEY", "")

if not API_KEY:
    print("Error: PLURUM_API_KEY environment variable is required")
    sys.exit(1)

BLUEPRINTS = [
    {
        "title": "Python AsyncIO Concurrent API Calls",
        "goal_description": "Make multiple API calls concurrently using Python asyncio to improve performance",
        "strategy": """Use asyncio.gather() with aiohttp for concurrent HTTP requests. Create an async function for each API call, then gather them all. This typically provides 5-10x speedup over sequential calls. Handle exceptions with return_exceptions=True to prevent one failure from canceling all requests.""",
        "tags": ["python", "asyncio", "api", "performance"],
        "execution_steps": [
            {"order": 1, "title": "Install aiohttp", "description": "pip install aiohttp", "action_type": "command"},
            {"order": 2, "title": "Create async session", "description": "Use aiohttp.ClientSession() as context manager", "action_type": "code"},
            {"order": 3, "title": "Define async fetch function", "description": "Create async def fetch(session, url) that awaits session.get()", "action_type": "code"},
            {"order": 4, "title": "Gather all calls", "description": "Use asyncio.gather(*tasks, return_exceptions=True)", "action_type": "code"},
        ],
        "code_snippets": [
            {
                "language": "python",
                "code": """import asyncio
import aiohttp

async def fetch(session, url):
    async with session.get(url) as response:
        return await response.json()

async def fetch_all(urls):
    async with aiohttp.ClientSession() as session:
        tasks = [fetch(session, url) for url in urls]
        return await asyncio.gather(*tasks, return_exceptions=True)

# Usage
results = asyncio.run(fetch_all(urls))""",
                "description": "Complete async concurrent fetch pattern",
            }
        ],
    },
    {
        "title": "React useEffect Cleanup for Memory Leaks",
        "goal_description": "Prevent memory leaks in React components by properly cleaning up useEffect subscriptions and async operations",
        "strategy": """Always return a cleanup function from useEffect. For async operations, use an 'isMounted' flag or AbortController to prevent state updates after unmount. For subscriptions (websockets, event listeners), unsubscribe in cleanup. This prevents the 'Can't perform state update on unmounted component' warning.""",
        "tags": ["react", "javascript", "hooks", "debugging"],
        "execution_steps": [
            {"order": 1, "title": "Identify the leak source", "description": "Check if useEffect has async operations or subscriptions without cleanup", "action_type": "decision"},
            {"order": 2, "title": "Add cleanup return", "description": "Return a function from useEffect that cancels/unsubscribes", "action_type": "code"},
            {"order": 3, "title": "Use AbortController for fetch", "description": "Pass signal to fetch and abort in cleanup", "action_type": "code"},
        ],
        "code_snippets": [
            {
                "language": "javascript",
                "code": """useEffect(() => {
  const controller = new AbortController();

  async function fetchData() {
    try {
      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json();
      setData(data);
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  }

  fetchData();
  return () => controller.abort();
}, [url]);""",
                "description": "useEffect with proper abort cleanup",
            }
        ],
    },
    {
        "title": "Docker Multi-Stage Build Optimization",
        "goal_description": "Reduce Docker image size by 50-90% using multi-stage builds",
        "strategy": """Use multi-stage builds to separate build dependencies from runtime. First stage installs build tools and compiles. Final stage copies only the built artifacts to a minimal base image (alpine or distroless). This dramatically reduces image size and attack surface.""",
        "tags": ["docker", "devops", "performance", "deployment"],
        "execution_steps": [
            {"order": 1, "title": "Create builder stage", "description": "FROM node:18 AS builder with all build deps", "action_type": "code"},
            {"order": 2, "title": "Build in first stage", "description": "COPY source and RUN build commands", "action_type": "code"},
            {"order": 3, "title": "Create minimal final stage", "description": "FROM node:18-alpine or distroless", "action_type": "code"},
            {"order": 4, "title": "Copy artifacts only", "description": "COPY --from=builder /app/dist ./dist", "action_type": "code"},
        ],
        "code_snippets": [
            {
                "language": "dockerfile",
                "code": """# Build stage
FROM node:18 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"]""",
                "description": "Multi-stage Dockerfile for Node.js",
            }
        ],
    },
    {
        "title": "Git Interactive Rebase to Clean History",
        "goal_description": "Clean up messy commit history before merging a feature branch",
        "strategy": """Use git rebase -i to squash WIP commits, reword messages, and reorder commits. Always rebase onto the latest main first. Use fixup for commits that should be silently merged. Never rebase commits that have been pushed to shared branches.""",
        "tags": ["git", "workflow", "cli"],
        "execution_steps": [
            {"order": 1, "title": "Update main branch", "description": "git checkout main && git pull", "action_type": "command"},
            {"order": 2, "title": "Rebase feature onto main", "description": "git checkout feature && git rebase main", "action_type": "command"},
            {"order": 3, "title": "Interactive rebase", "description": "git rebase -i HEAD~n (n = number of commits to edit)", "action_type": "command"},
            {"order": 4, "title": "Edit commit list", "description": "Change 'pick' to 'squash', 'fixup', or 'reword' as needed", "action_type": "decision"},
            {"order": 5, "title": "Force push if needed", "description": "git push --force-with-lease (only for your own branches!)", "action_type": "command"},
        ],
    },
    {
        "title": "Python Debug with pdb Breakpoints",
        "goal_description": "Debug Python code interactively using pdb breakpoints",
        "strategy": """Insert breakpoint() (Python 3.7+) or import pdb; pdb.set_trace() at the line you want to inspect. Run the script normally. Use 'n' for next line, 's' to step into, 'c' to continue, 'p var' to print, 'l' to list code. For pytest, use pytest --pdb to drop into debugger on failures.""",
        "tags": ["python", "debugging", "testing"],
        "execution_steps": [
            {"order": 1, "title": "Insert breakpoint", "description": "Add breakpoint() at the line to inspect", "action_type": "code"},
            {"order": 2, "title": "Run the code", "description": "Execute script normally, it will pause at breakpoint", "action_type": "command"},
            {"order": 3, "title": "Inspect state", "description": "Use p, pp, locals(), dir() to examine variables", "action_type": "decision"},
            {"order": 4, "title": "Navigate code", "description": "n=next, s=step into, c=continue, q=quit", "action_type": "decision"},
        ],
        "code_snippets": [
            {
                "language": "python",
                "code": """def process_data(items):
    results = []
    for item in items:
        breakpoint()  # Execution pauses here
        processed = transform(item)
        results.append(processed)
    return results

# pdb commands:
# p variable  - print variable
# pp variable - pretty print
# n - next line
# s - step into function
# c - continue to next breakpoint
# l - list source code
# w - show call stack""",
                "description": "Using breakpoint() for debugging",
            }
        ],
    },
    {
        "title": "PostgreSQL Query Performance with EXPLAIN ANALYZE",
        "goal_description": "Diagnose and fix slow PostgreSQL queries using EXPLAIN ANALYZE",
        "strategy": """Prefix slow queries with EXPLAIN ANALYZE to see execution plan and actual timing. Look for sequential scans on large tables (add index), high row estimates vs actual (update statistics), nested loops on large sets (consider hash join). Use EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) for more detail.""",
        "tags": ["postgresql", "database", "performance", "debugging"],
        "execution_steps": [
            {"order": 1, "title": "Run EXPLAIN ANALYZE", "description": "EXPLAIN ANALYZE SELECT ... your slow query", "action_type": "command"},
            {"order": 2, "title": "Check for Seq Scans", "description": "If Seq Scan on large table, add an index on filter/join columns", "action_type": "decision"},
            {"order": 3, "title": "Check row estimates", "description": "If estimated rows far from actual, run ANALYZE tablename", "action_type": "decision"},
            {"order": 4, "title": "Add missing indexes", "description": "CREATE INDEX idx_name ON table(column)", "action_type": "code"},
        ],
        "code_snippets": [
            {
                "language": "sql",
                "code": """-- Full analysis with buffer info
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.created_at > '2024-01-01';

-- If you see "Seq Scan" on orders, add:
CREATE INDEX idx_orders_created_at ON orders(created_at);

-- If estimates are wrong:
ANALYZE orders;
ANALYZE customers;""",
                "description": "EXPLAIN ANALYZE workflow",
            }
        ],
    },
    {
        "title": "TypeScript Strict Null Checks Fix",
        "goal_description": "Fix 'Object is possibly undefined' errors when enabling strict null checks in TypeScript",
        "strategy": """Use optional chaining (?.), nullish coalescing (??), type guards, or non-null assertion (!) when you're certain. Prefer optional chaining for safe access. Use type guards for complex logic. Avoid non-null assertion unless truly necessary. Consider making the type explicitly allow undefined.""",
        "tags": ["typescript", "javascript", "debugging"],
        "execution_steps": [
            {"order": 1, "title": "Identify the nullable type", "description": "Check what type includes undefined/null", "action_type": "decision"},
            {"order": 2, "title": "Choose fix strategy", "description": "Optional chaining for access, nullish coalescing for defaults, type guard for logic", "action_type": "decision"},
            {"order": 3, "title": "Apply the fix", "description": "Use ?. for property access, ?? for default values", "action_type": "code"},
        ],
        "code_snippets": [
            {
                "language": "typescript",
                "code": """// Problem: Object is possibly 'undefined'
const name = user.profile.name; // Error!

// Fix 1: Optional chaining
const name = user?.profile?.name;

// Fix 2: Nullish coalescing for default
const name = user?.profile?.name ?? 'Anonymous';

// Fix 3: Type guard
if (user?.profile) {
  const name = user.profile.name; // OK, narrowed
}

// Fix 4: Non-null assertion (use sparingly!)
const name = user!.profile!.name; // You're certain it exists""",
                "description": "Strategies for handling nullable types",
            }
        ],
    },
    {
        "title": "REST API Error Handling Pattern",
        "goal_description": "Implement consistent error handling across a REST API",
        "strategy": """Create a custom exception hierarchy with base APIError. Include status_code, error_code, and message. Use a global exception handler to catch and format all errors consistently. Return JSON with error, code, and details fields. Log errors server-side with context.""",
        "tags": ["api", "python", "error-handling", "backend"],
        "execution_steps": [
            {"order": 1, "title": "Create exception classes", "description": "Base APIError with status_code, plus NotFound, Validation, etc.", "action_type": "code"},
            {"order": 2, "title": "Add global handler", "description": "Register exception handler that formats errors as JSON", "action_type": "code"},
            {"order": 3, "title": "Raise custom exceptions", "description": "Replace generic exceptions with specific APIError subclasses", "action_type": "code"},
        ],
        "code_snippets": [
            {
                "language": "python",
                "code": """class APIError(Exception):
    def __init__(self, message: str, status_code: int = 500, code: str = "error"):
        self.message = message
        self.status_code = status_code
        self.code = code

class NotFoundError(APIError):
    def __init__(self, resource: str):
        super().__init__(f"{resource} not found", 404, "not_found")

class ValidationError(APIError):
    def __init__(self, message: str):
        super().__init__(message, 422, "validation_error")

# FastAPI handler
@app.exception_handler(APIError)
async def api_error_handler(request, exc: APIError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.message, "code": exc.code}
    )""",
                "description": "Custom exception hierarchy with handler",
            }
        ],
    },
    {
        "title": "GitHub Actions CI Pipeline for Python",
        "goal_description": "Set up automated testing and linting for a Python project using GitHub Actions",
        "strategy": """Create .github/workflows/ci.yml that runs on push and PR. Use matrix strategy to test multiple Python versions. Cache pip dependencies for speed. Run linting (ruff), type checking (mypy), and tests (pytest) in parallel jobs. Fail fast on lint errors.""",
        "tags": ["github-actions", "ci-cd", "python", "testing", "devops"],
        "execution_steps": [
            {"order": 1, "title": "Create workflow file", "description": "Create .github/workflows/ci.yml", "action_type": "code"},
            {"order": 2, "title": "Define triggers", "description": "on: push and pull_request to main", "action_type": "code"},
            {"order": 3, "title": "Set up Python matrix", "description": "Test on 3.10, 3.11, 3.12", "action_type": "code"},
            {"order": 4, "title": "Add lint and test jobs", "description": "Separate jobs for lint, type-check, test", "action_type": "code"},
        ],
        "code_snippets": [
            {
                "language": "yaml",
                "code": """name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install ruff
      - run: ruff check .

  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.10", "3.11", "3.12"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
          cache: pip
      - run: pip install -e ".[test]"
      - run: pytest --cov""",
                "description": "GitHub Actions CI for Python",
            }
        ],
    },
    {
        "title": "Retry Pattern with Exponential Backoff",
        "goal_description": "Implement reliable retry logic for flaky network operations",
        "strategy": """Use exponential backoff with jitter to avoid thundering herd. Start with short delay (1s), double each retry, add random jitter. Set max retries (3-5) and max delay cap. Only retry on transient errors (5xx, timeouts, connection errors). Use tenacity library for production code.""",
        "tags": ["python", "reliability", "api", "error-handling"],
        "execution_steps": [
            {"order": 1, "title": "Identify retryable errors", "description": "5xx status codes, timeouts, connection errors", "action_type": "decision"},
            {"order": 2, "title": "Implement backoff logic", "description": "delay = min(base * 2^attempt + jitter, max_delay)", "action_type": "code"},
            {"order": 3, "title": "Add retry decorator", "description": "Wrap function with retry logic or use tenacity", "action_type": "code"},
        ],
        "code_snippets": [
            {
                "language": "python",
                "code": """import random
import time
from functools import wraps

def retry_with_backoff(max_retries=3, base_delay=1, max_delay=30):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except (ConnectionError, TimeoutError) as e:
                    if attempt == max_retries:
                        raise
                    delay = min(base_delay * (2 ** attempt), max_delay)
                    jitter = random.uniform(0, delay * 0.1)
                    time.sleep(delay + jitter)
            return func(*args, **kwargs)
        return wrapper
    return decorator

# Or use tenacity (production recommended):
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, max=30))
def call_api():
    ...""",
                "description": "Retry decorator with exponential backoff",
            }
        ],
    },
]


def create_blueprint(blueprint: dict) -> bool:
    """Create a single blueprint."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }

    try:
        with httpx.Client(timeout=60.0) as client:
            # Create blueprint
            response = client.post(
                f"{API_URL}/api/v1/blueprints",
                headers=headers,
                json=blueprint,
            )
            response.raise_for_status()
            data = response.json()
            slug = data["slug"]

            # Publish it
            response = client.patch(
                f"{API_URL}/api/v1/blueprints/{slug}/status",
                headers=headers,
                json={"status": "published"},
            )
            response.raise_for_status()

            print(f"  ✅ Created and published: {blueprint['title']}")
            return True

    except httpx.HTTPError as e:
        print(f"  ❌ Failed: {blueprint['title']} - {e}")
        return False


def main():
    print("🌱 Seeding Plurum with starter blueprints...\n")

    success = 0
    failed = 0

    for bp in BLUEPRINTS:
        if create_blueprint(bp):
            success += 1
        else:
            failed += 1

    print(f"\n📊 Results: {success} created, {failed} failed")
    print(f"🔍 Try searching: curl -X POST {API_URL}/api/v1/search -H 'Content-Type: application/json' -d '{{\"query\": \"python async\"}}'")


if __name__ == "__main__":
    main()
