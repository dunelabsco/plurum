"""Security checks for credentials in collective content."""

from unittest.mock import MagicMock
from uuid import UUID

import pytest

from app.core.content_security import reject_api_keys
from app.core.exceptions import ValidationError
from app.services.experience_assembler import ExperienceAssembler
from app.services.experience_service import ExperienceService


FAKE_PLURUM_KEY = "plrm_live_abcdefghijklmnopqrstuvwxyz"


@pytest.mark.parametrize(
    "api_key",
    [
        f"sk-{'a' * 20}",
        f"sk-ant-{'a' * 20}",
        f"ghp_{'a' * 36}",
        f"gho_{'a' * 36}",
        FAKE_PLURUM_KEY,
        f"AKIA{'A' * 16}",
    ],
)
def test_recognizable_provider_keys_are_rejected(api_key):
    with pytest.raises(ValidationError):
        reject_api_keys({"context": api_key})


@pytest.mark.parametrize(
    ("value", "expected_path"),
    [
        (
            {"artifacts": [{"language": "env", "code": FAKE_PLURUM_KEY}]},
            "experience.artifacts[0].code",
        ),
        (
            {"gotchas": [{"warning": "Do not leak it", "context": FAKE_PLURUM_KEY}]},
            "experience.gotchas[0].context",
        ),
        ({"tags": [FAKE_PLURUM_KEY]}, "experience.tags[0]"),
        (
            {"context_structured": {"environment": FAKE_PLURUM_KEY}},
            "experience.context_structured.environment",
        ),
    ],
)
def test_nested_api_keys_are_rejected_without_echoing_value(value, expected_path):
    with pytest.raises(ValidationError) as exc_info:
        reject_api_keys(value)

    assert exc_info.value.details == {"field": expected_path}
    assert FAKE_PLURUM_KEY not in exc_info.value.message


@pytest.mark.parametrize(
    "text",
    [
        "password=hunter2",
        "Bearer this-is-an-example-token-value",
        "OPENAI_API_KEY=YOUR_OPENAI_API_KEY",
        "DATABASE_PASSWORD=YOUR_PASSWORD",
    ],
)
def test_generic_credentials_and_placeholders_are_not_blocked(text):
    reject_api_keys({"artifact": {"code": text}})


def test_manual_create_rejects_nested_key_before_embedding_or_database():
    service = ExperienceService.__new__(ExperienceService)
    service.embedding = MagicMock()
    service.repo = MagicMock()
    data = {
        "goal": "Document a safe deployment process",
        "artifacts": [{"language": "env", "code": FAKE_PLURUM_KEY}],
    }

    with pytest.raises(ValidationError):
        service.create(UUID("00000000-0000-0000-0000-000000000001"), data)

    service.embedding.generate_reasoning_embedding.assert_not_called()
    service.repo.create.assert_not_called()


def test_session_assembly_rejects_nested_key_before_embedding_or_database():
    assembler = ExperienceAssembler.__new__(ExperienceAssembler)
    assembler.session_repo = MagicMock()
    assembler.experience_repo = MagicMock()
    assembler.embedding = MagicMock()
    assembler.session_repo.get_by_id.return_value = {
        "topic": "Document a safe deployment process",
        "visibility": "public",
        "tools_used": [],
    }
    assembler.session_repo.list_entries.return_value = [{
        "entry_type": "artifact",
        "content": {
            "language": "env",
            "code": FAKE_PLURUM_KEY,
            "description": "Example configuration",
        },
    }]

    with pytest.raises(ValidationError):
        assembler.assemble_from_session(
            UUID("00000000-0000-0000-0000-000000000010"),
            UUID("00000000-0000-0000-0000-000000000001"),
        )

    assembler.embedding.generate_reasoning_embedding.assert_not_called()
    assembler.experience_repo.create.assert_not_called()


def test_publish_rechecks_existing_draft_before_making_it_public():
    agent_id = UUID("00000000-0000-0000-0000-000000000001")
    service = ExperienceService.__new__(ExperienceService)
    service.repo = MagicMock()
    service.repo.get_by_identifier.return_value = {
        "id": "00000000-0000-0000-0000-000000000100",
        "agent_id": str(agent_id),
        "status": "draft",
        "visibility": "public",
        "artifacts": [{"language": "env", "code": FAKE_PLURUM_KEY}],
    }

    with pytest.raises(ValidationError):
        service.publish("Ab3xKp9z", agent_id)

    service.repo.update.assert_not_called()


def test_outcome_report_rejects_nested_key_before_database():
    agent_id = UUID("00000000-0000-0000-0000-000000000001")
    service = ExperienceService.__new__(ExperienceService)
    service.repo = MagicMock()
    service.repo.get_by_identifier.return_value = {
        "id": "00000000-0000-0000-0000-000000000100",
        "agent_id": "00000000-0000-0000-0000-000000000002",
        "status": "published",
        "visibility": "public",
    }

    with pytest.raises(ValidationError):
        service.report_outcome(
            "Ab3xKp9z",
            agent_id,
            success=False,
            env_fingerprint={"token": FAKE_PLURUM_KEY},
        )

    service.repo.upsert_outcome_report.assert_not_called()
