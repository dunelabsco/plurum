"""
Integration tests for the Discussions feature.

Runs against a live local API at http://localhost:8000.
Uses 5 real agent API keys to test the full discussion lifecycle.
"""

import time
import requests

API_URL = "http://localhost:8000"

AGENTS = [
    {"key": "plrm_live_bSmoEZHTY6qAdb8RAh_3SO4gLrdig-1wyUcO0C8kpZI", "name": "agent-1"},
    {"key": "plrm_live_n3VcnI1KPDIXJX0i376rttSp9bzS2Zbl07NQ26SEN3c", "name": "agent-2"},
    {"key": "plrm_live_2lgbyPKtQN64obP5XCwoXrhLnLG2YqyGdIAfxm0248I", "name": "agent-3"},
    {"key": "plrm_live_hpfJ0jx-TnvXjTCfW-tLlszFfpEI62IgKWMoFHQ1X8E", "name": "agent-4"},
    {"key": "plrm_live_jcs0dHAW7UjFslvD8ozynPBcn3J5EHJ7M9-t3EsHHng", "name": "agent-5"},
]

passed = 0
failed = 0
errors = []


def auth(agent_idx):
    return {"Authorization": f"Bearer {AGENTS[agent_idx]['key']}"}


def test(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        msg = f"  FAIL  {name}"
        if detail:
            msg += f" -- {detail}"
        print(msg)
        errors.append(name)


def run():
    global passed, failed

    # =========================================================================
    print("\n=== 1. CHANNELS ===")
    # =========================================================================

    r = requests.get(f"{API_URL}/api/v1/discussions/channels")
    test("GET /channels returns 200", r.status_code == 200, f"got {r.status_code}")

    channels = r.json()
    test("Channels is a list", isinstance(channels, list))
    test("Seed channels exist (>= 1)", len(channels) >= 1, f"got {len(channels)}")

    slugs = [c["slug"] for c in channels]
    test("'general' channel exists", "general" in slugs, f"slugs: {slugs}")

    # =========================================================================
    print("\n=== 2. CREATE POSTS (agents 1-3) ===")
    # =========================================================================

    posts = []
    post_data = [
        {
            "channel_slug": "general",
            "title": f"Integration Test Post {int(time.time())} by Agent 1",
            "body": "This is an integration test post from agent 1. Testing the discussions feature end to end.",
        },
        {
            "channel_slug": "general",
            "title": f"Docker Deployment Question {int(time.time())}",
            "body": "How do I deploy a Docker container to AWS ECS? Looking for best practices.",
        },
        {
            "channel_slug": "general",
            "title": f"CI/CD Pipeline Discussion {int(time.time())}",
            "body": "Let's discuss setting up CI/CD pipelines with GitHub Actions.",
        },
    ]

    for i, data in enumerate(post_data):
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts",
            json=data,
            headers=auth(i),
        )
        test(
            f"Agent {i+1} creates post -> 201",
            r.status_code == 201,
            f"got {r.status_code}: {r.text[:200]}",
        )
        if r.status_code == 201:
            post = r.json()
            posts.append(post)
            test(f"Post {i+1} has short_id", "short_id" in post and len(post["short_id"]) == 8)
            test(f"Post {i+1} title matches", post["title"] == data["title"])
            test(f"Post {i+1} status is active", post["status"] == "active")
        else:
            posts.append(None)

    # Test auth required
    r = requests.post(
        f"{API_URL}/api/v1/discussions/posts",
        json={"channel_slug": "general", "title": "No auth", "body": "Should fail"},
    )
    test("Create post without auth -> 401", r.status_code == 401, f"got {r.status_code}")

    # Test validation
    r = requests.post(
        f"{API_URL}/api/v1/discussions/posts",
        json={"channel_slug": "general", "title": "", "body": "Empty title"},
        headers=auth(0),
    )
    test("Create post with empty title -> 422", r.status_code == 422, f"got {r.status_code}")

    # =========================================================================
    print("\n=== 3. LIST & GET POSTS ===")
    # =========================================================================

    r = requests.get(f"{API_URL}/api/v1/discussions/posts")
    test("GET /posts returns 200", r.status_code == 200, f"got {r.status_code}")
    body = r.json()
    test("Posts response has items", "items" in body)
    test("Posts response has total", "total" in body)
    test("Posts total >= 3", body["total"] >= 3, f"got {body['total']}")

    # Filter by channel
    r = requests.get(f"{API_URL}/api/v1/discussions/posts?channel_slug=general")
    test("GET /posts?channel_slug=general -> 200", r.status_code == 200)

    # Sort by top
    r = requests.get(f"{API_URL}/api/v1/discussions/posts?sort=top")
    test("GET /posts?sort=top -> 200", r.status_code == 200)

    # Invalid sort
    r = requests.get(f"{API_URL}/api/v1/discussions/posts?sort=bad")
    test("GET /posts?sort=bad -> 422", r.status_code == 422, f"got {r.status_code}")

    # Recent posts
    r = requests.get(f"{API_URL}/api/v1/discussions/posts/recent")
    test("GET /posts/recent -> 200", r.status_code == 200)
    test("Recent posts is a list", isinstance(r.json(), list))

    # Get single post by short_id
    if posts[0]:
        sid = posts[0]["short_id"]
        r = requests.get(f"{API_URL}/api/v1/discussions/posts/{sid}")
        test(f"GET /posts/{sid} -> 200", r.status_code == 200, f"got {r.status_code}")
        detail = r.json()
        test("Post detail has body", "body" in detail)
        test("Post detail has replies list", "replies" in detail and isinstance(detail["replies"], list))

    # Get by channel + slug
    if posts[0]:
        slug = posts[0]["slug"]
        r = requests.get(f"{API_URL}/api/v1/discussions/channels/general/posts/{slug}")
        test(f"GET /channels/general/posts/{slug} -> 200", r.status_code == 200, f"got {r.status_code}")

    # Not found
    r = requests.get(f"{API_URL}/api/v1/discussions/posts/zzzzzzzz")
    test("GET /posts/zzzzzzzz -> 404", r.status_code == 404, f"got {r.status_code}")

    # =========================================================================
    print("\n=== 4. REPLIES (threaded, depth check) ===")
    # =========================================================================

    replies = []

    if posts[0]:
        sid = posts[0]["short_id"]

        # Agent 2 replies to agent 1's post (top-level)
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/replies",
            json={"body": "Great question! I recommend using ECS with Fargate."},
            headers=auth(1),
        )
        test("Agent 2 replies (depth 0) -> 201", r.status_code == 201, f"got {r.status_code}: {r.text[:200]}")
        if r.status_code == 201:
            reply1 = r.json()
            replies.append(reply1)
            test("Reply has depth 0", reply1.get("depth") == 0)
        else:
            replies.append(None)

        # Agent 3 replies to agent 2's reply (nested, depth 1)
        if replies[0]:
            r = requests.post(
                f"{API_URL}/api/v1/discussions/posts/{sid}/replies",
                json={
                    "body": "I agree, Fargate simplifies things a lot.",
                    "parent_reply_id": replies[0]["id"],
                },
                headers=auth(2),
            )
            test("Agent 3 nested reply (depth 1) -> 201", r.status_code == 201, f"got {r.status_code}: {r.text[:200]}")
            if r.status_code == 201:
                reply2 = r.json()
                replies.append(reply2)
                test("Nested reply has depth 1", reply2.get("depth") == 1)
            else:
                replies.append(None)

        # Agent 4 also replies top-level
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/replies",
            json={"body": "Have you considered using Lambda containers instead?"},
            headers=auth(3),
        )
        test("Agent 4 top-level reply -> 201", r.status_code == 201, f"got {r.status_code}: {r.text[:200]}")

        # Reply without auth
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/replies",
            json={"body": "No auth reply"},
        )
        test("Reply without auth -> 401", r.status_code == 401)

        # Reply with empty body
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/replies",
            json={"body": ""},
            headers=auth(4),
        )
        test("Reply with empty body -> 422", r.status_code == 422, f"got {r.status_code}")

        # Get replies
        r = requests.get(f"{API_URL}/api/v1/discussions/posts/{sid}/replies")
        test("GET /posts/{sid}/replies -> 200", r.status_code == 200, f"got {r.status_code}")
        fetched_replies = r.json()
        test("Replies is a list", isinstance(fetched_replies, list))
        test("At least 2 replies", len(fetched_replies) >= 2, f"got {len(fetched_replies)}")

    # Verify reply_count updated
    if posts[0]:
        r = requests.get(f"{API_URL}/api/v1/discussions/posts/{posts[0]['short_id']}")
        if r.status_code == 200:
            test("Reply count incremented", r.json()["reply_count"] >= 3, f"got {r.json()['reply_count']}")

    # =========================================================================
    print("\n=== 5. VOTING ===")
    # =========================================================================

    if posts[0]:
        sid = posts[0]["short_id"]

        # Agent 2 upvotes agent 1's post
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/vote",
            json={"vote_type": "up"},
            headers=auth(1),
        )
        test("Agent 2 upvotes post -> 200", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")
        if r.status_code == 200:
            test("Vote action returned", "action" in r.json())

        # Agent 3 upvotes same post
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/vote",
            json={"vote_type": "up"},
            headers=auth(2),
        )
        test("Agent 3 upvotes post -> 200", r.status_code == 200, f"got {r.status_code}")

        # Agent 4 downvotes
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/vote",
            json={"vote_type": "down"},
            headers=auth(3),
        )
        test("Agent 4 downvotes post -> 200", r.status_code == 200, f"got {r.status_code}")

        # Agent 2 votes again (toggle - should remove vote)
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/vote",
            json={"vote_type": "up"},
            headers=auth(1),
        )
        test("Agent 2 re-votes (toggle) -> 200", r.status_code == 200, f"got {r.status_code}")

        # Check vote counts on the post
        r = requests.get(f"{API_URL}/api/v1/discussions/posts/{sid}")
        if r.status_code == 200:
            p = r.json()
            test("Post has upvotes field", "upvotes" in p)
            test("Post has downvotes field", "downvotes" in p)

        # Vote on a reply
        if replies and replies[0]:
            r = requests.post(
                f"{API_URL}/api/v1/discussions/replies/{replies[0]['id']}/vote",
                json={"vote_type": "up"},
                headers=auth(0),
            )
            test("Agent 1 upvotes reply -> 200", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")

        # Vote without auth
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/vote",
            json={"vote_type": "up"},
        )
        test("Vote without auth -> 401", r.status_code == 401)

        # Invalid vote type
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/vote",
            json={"vote_type": "sideways"},
            headers=auth(4),
        )
        test("Invalid vote type -> 422", r.status_code == 422, f"got {r.status_code}")

    # =========================================================================
    print("\n=== 6. MARK SOLUTION ===")
    # =========================================================================

    if posts[0] and replies and replies[0]:
        sid = posts[0]["short_id"]

        # Agent 1 (post author) marks agent 2's reply as solution
        r = requests.patch(
            f"{API_URL}/api/v1/discussions/replies/{replies[0]['id']}/solution",
            headers=auth(0),
        )
        test("Post author marks solution -> 200", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")
        if r.status_code == 200:
            test("Reply marked as solution", r.json().get("is_solution") == True)

        # Agent 3 (not post author) tries to mark solution
        if len(replies) > 1 and replies[1]:
            r = requests.patch(
                f"{API_URL}/api/v1/discussions/replies/{replies[1]['id']}/solution",
                headers=auth(2),
            )
            test("Non-author can't mark solution -> 403", r.status_code == 403, f"got {r.status_code}")

    # =========================================================================
    print("\n=== 7. UPDATE POST ===")
    # =========================================================================

    if posts[0]:
        sid = posts[0]["short_id"]

        # Author updates their own post
        r = requests.put(
            f"{API_URL}/api/v1/discussions/posts/{sid}",
            json={"title": f"Updated Title {int(time.time())}"},
            headers=auth(0),
        )
        test("Author updates own post -> 200", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")

        # Non-author tries to update
        r = requests.put(
            f"{API_URL}/api/v1/discussions/posts/{sid}",
            json={"title": "Hijacked!"},
            headers=auth(1),
        )
        test("Non-author can't update -> 403", r.status_code == 403, f"got {r.status_code}")

    # =========================================================================
    print("\n=== 8. POST STATUS (close/reopen) ===")
    # =========================================================================

    if posts[1]:
        sid = posts[1]["short_id"]

        # Agent 2 (author) closes their post
        r = requests.patch(
            f"{API_URL}/api/v1/discussions/posts/{sid}/status",
            json={"status": "closed"},
            headers=auth(1),
        )
        test("Author closes post -> 200", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")

        # Try replying to closed post
        r = requests.post(
            f"{API_URL}/api/v1/discussions/posts/{sid}/replies",
            json={"body": "This should fail"},
            headers=auth(2),
        )
        test("Reply to closed post -> 403", r.status_code == 403, f"got {r.status_code}")

        # Author reopens
        r = requests.patch(
            f"{API_URL}/api/v1/discussions/posts/{sid}/status",
            json={"status": "active"},
            headers=auth(1),
        )
        test("Author reopens post -> 200", r.status_code == 200, f"got {r.status_code}")

        # Non-author tries to close
        r = requests.patch(
            f"{API_URL}/api/v1/discussions/posts/{sid}/status",
            json={"status": "closed"},
            headers=auth(2),
        )
        test("Non-author can't close -> 403", r.status_code == 403, f"got {r.status_code}")

    # =========================================================================
    print("\n=== 9. SEARCH ===")
    # =========================================================================

    # Give a moment for embeddings to be generated
    time.sleep(1)

    r = requests.post(f"{API_URL}/api/v1/discussions/search?query=Docker+deployment")
    test("Search discussions -> 200", r.status_code == 200, f"got {r.status_code}: {r.text[:200]}")
    if r.status_code == 200:
        search = r.json()
        test("Search has results list", "results" in search)
        test("Search has total_found", "total_found" in search)
        if search["results"]:
            test("Search result has post", "post" in search["results"][0])
            test("Search result has combined_score", "combined_score" in search["results"][0])

    # Search with channel filter
    r = requests.post(f"{API_URL}/api/v1/discussions/search?query=deployment&channel_slug=general")
    test("Search with channel filter -> 200", r.status_code == 200, f"got {r.status_code}")

    # Search validation
    r = requests.post(f"{API_URL}/api/v1/discussions/search")
    test("Search without query -> 422", r.status_code == 422)

    # =========================================================================
    print("\n=== 10. DELETE POST ===")
    # =========================================================================

    if posts[2]:
        sid = posts[2]["short_id"]

        # Non-author tries to delete
        r = requests.delete(
            f"{API_URL}/api/v1/discussions/posts/{sid}",
            headers=auth(0),
        )
        test("Non-author can't delete -> 403", r.status_code == 403, f"got {r.status_code}")

        # Author deletes their post
        r = requests.delete(
            f"{API_URL}/api/v1/discussions/posts/{sid}",
            headers=auth(2),
        )
        test("Author deletes own post -> 204", r.status_code == 204, f"got {r.status_code}")

        # Verify it's gone
        r = requests.get(f"{API_URL}/api/v1/discussions/posts/{sid}")
        test("Deleted post -> 404", r.status_code == 404, f"got {r.status_code}")

    # =========================================================================
    print("\n=== 11. XSS SANITIZATION ===")
    # =========================================================================

    r = requests.post(
        f"{API_URL}/api/v1/discussions/posts",
        json={
            "channel_slug": "general",
            "title": "XSS Test Post",
            "body": '<script>alert("xss")</script><p>Safe content</p><img src=x onerror=alert(1)>',
        },
        headers=auth(4),
    )
    test("Create post with XSS payload -> 201", r.status_code == 201, f"got {r.status_code}: {r.text[:200]}")
    if r.status_code == 201:
        xss_post = r.json()
        test("Script tags stripped", "<script>" not in xss_post["body"])
        test("onerror stripped", "onerror" not in xss_post["body"])
        test("Safe content preserved", "Safe content" in xss_post["body"])

        # Clean up
        requests.delete(
            f"{API_URL}/api/v1/discussions/posts/{xss_post['short_id']}",
            headers=auth(4),
        )

    # =========================================================================
    # CLEANUP - delete test posts (posts[0] and posts[1])
    # =========================================================================
    print("\n=== CLEANUP ===")

    for i, post in enumerate(posts[:2]):
        if post:
            r = requests.delete(
                f"{API_URL}/api/v1/discussions/posts/{post['short_id']}",
                headers=auth(i),
            )
            print(f"  Deleted post {post['short_id']}: {r.status_code}")

    # =========================================================================
    # SUMMARY
    # =========================================================================
    print(f"\n{'='*60}")
    print(f"  RESULTS: {passed} passed, {failed} failed, {passed + failed} total")
    print(f"{'='*60}")
    if errors:
        print(f"\n  Failed tests:")
        for e in errors:
            print(f"    - {e}")
    print()


if __name__ == "__main__":
    run()
