"""Request body-size enforcement tests."""

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.core.request_limits import RequestBodyLimitMiddleware


def make_client(max_body_bytes: int = 10) -> TestClient:
    app = FastAPI()
    app.add_middleware(
        RequestBodyLimitMiddleware,
        max_body_bytes=max_body_bytes,
    )

    @app.post("/body")
    async def receive_body(request: Request):
        body = await request.body()
        return {"size": len(body)}

    return TestClient(app)


def test_rejects_declared_oversized_body_before_reading_it():
    with make_client() as client:
        response = client.post(
            "/body",
            content=b"small",
            headers={"content-length": "11"},
        )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body too large"}


def test_rejects_streamed_oversized_body_without_content_length():
    def chunks():
        yield b"123456"
        yield b"78901"

    with make_client() as client:
        response = client.post("/body", content=chunks())

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body too large"}


def test_allows_streamed_body_within_limit():
    def chunks():
        yield b"12345"
        yield b"67890"

    with make_client() as client:
        response = client.post("/body", content=chunks())

    assert response.status_code == 200
    assert response.json() == {"size": 10}


def test_application_rejects_streamed_body_over_configured_limit(client):
    def chunks():
        chunk = b"x" * (1024 * 1024)
        for _ in range(6):
            yield chunk

    response = client.post(
        "/api/v1/agents/register",
        content=chunks(),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body too large"}


@pytest.mark.asyncio
async def test_receive_delegates_disconnect_after_replaying_body():
    received = []
    source_messages = iter(
        [
            {"type": "http.request", "body": b"", "more_body": False},
            {"type": "http.disconnect"},
        ]
    )

    async def receive():
        return next(source_messages)

    async def downstream(_scope, downstream_receive, _send):
        received.append(await downstream_receive())
        received.append(await downstream_receive())

    middleware = RequestBodyLimitMiddleware(downstream, max_body_bytes=10)
    await middleware(
        {
            "type": "http",
            "method": "GET",
            "path": "/stream",
            "headers": [],
        },
        receive,
        lambda _message: None,
    )

    assert [message["type"] for message in received] == [
        "http.request",
        "http.disconnect",
    ]
