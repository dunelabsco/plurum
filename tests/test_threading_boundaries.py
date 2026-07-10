"""Regression tests for synchronous I/O thread-pool boundaries."""

import inspect

import pytest

from app.api.v1.agents import get_current_profile
from app.api.v1.experiences import create_experience, search_experiences
from app.api.v1.pulse import get_inbox, pulse_status
from app.api.v1.sessions import list_sessions
from app.core.security import get_current_agent, get_current_user


@pytest.mark.parametrize(
    "handler",
    [
        create_experience,
        search_experiences,
        get_current_profile,
        list_sessions,
        pulse_status,
        get_inbox,
        get_current_agent,
        get_current_user,
    ],
)
def test_sync_io_handlers_use_fastapi_thread_pool(handler):
    assert not inspect.iscoroutinefunction(handler)
