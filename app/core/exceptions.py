"""Custom exceptions for the Plurum API."""

from __future__ import annotations

from typing import Any, Optional


class PlurimException(Exception):
    """Base exception for all Plurum errors."""

    def __init__(
        self,
        message: str,
        status_code: int = 500,
        details: Optional[dict[str, Any]] = None,
    ):
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class NotFoundError(PlurimException):
    """Resource not found."""

    def __init__(self, resource: str, identifier: str):
        super().__init__(
            message=f"{resource} not found: {identifier}",
            status_code=404,
            details={"resource": resource, "identifier": identifier},
        )


class ValidationError(PlurimException):
    """Validation failed."""

    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            status_code=422,
            details=details,
        )


class AuthenticationError(PlurimException):
    """Authentication failed."""

    def __init__(self, message: str = "Invalid or missing API key"):
        super().__init__(
            message=message,
            status_code=401,
        )


class AuthorizationError(PlurimException):
    """Authorization failed."""

    def __init__(self, message: str = "You don't have permission to perform this action"):
        super().__init__(
            message=message,
            status_code=403,
        )


class RateLimitError(PlurimException):
    """Rate limit exceeded."""

    def __init__(self, retry_after: int = 60):
        super().__init__(
            message="Rate limit exceeded",
            status_code=429,
            details={"retry_after": retry_after},
        )


class DuplicateError(PlurimException):
    """Duplicate resource."""

    def __init__(self, message: str, resource: str | None = None, identifier: str | None = None):
        details = {}
        if resource:
            details["resource"] = resource
        if identifier:
            details["identifier"] = identifier
        super().__init__(
            message=message,
            status_code=409,
            details=details,
        )
