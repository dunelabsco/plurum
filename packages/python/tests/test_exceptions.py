"""
Tests for Plurum SDK exception classes
"""

import pytest

from plurum._exceptions import (
    PlurimError,
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    ValidationError,
)


class TestPlurimError:
    def test_create_with_message(self):
        error = PlurimError("Something went wrong")
        assert str(error) == "Something went wrong"
        assert error.message == "Something went wrong"
        assert error.status_code is None

    def test_create_with_message_and_status(self):
        error = PlurimError("Server error", status_code=500)
        assert error.message == "Server error"
        assert error.status_code == 500

    def test_is_exception(self):
        error = PlurimError("Test")
        assert isinstance(error, Exception)


class TestAuthenticationError:
    def test_default_message(self):
        error = AuthenticationError()
        assert error.message == "Invalid or missing API key"
        assert error.status_code == 401

    def test_custom_message(self):
        error = AuthenticationError("Token expired")
        assert error.message == "Token expired"
        assert error.status_code == 401

    def test_is_plurim_error(self):
        error = AuthenticationError()
        assert isinstance(error, PlurimError)


class TestNotFoundError:
    def test_default_message(self):
        error = NotFoundError()
        assert error.message == "Resource not found"
        assert error.status_code == 404

    def test_custom_message(self):
        error = NotFoundError("Blueprint not found")
        assert error.message == "Blueprint not found"

    def test_is_plurim_error(self):
        error = NotFoundError()
        assert isinstance(error, PlurimError)


class TestRateLimitError:
    def test_default_message(self):
        error = RateLimitError()
        assert error.message == "Rate limit exceeded"
        assert error.status_code == 429

    def test_custom_message(self):
        error = RateLimitError("Too many requests, retry in 60s")
        assert error.message == "Too many requests, retry in 60s"


class TestValidationError:
    def test_requires_message(self):
        error = ValidationError("Title is required")
        assert error.message == "Title is required"
        assert error.status_code == 422

    def test_is_plurim_error(self):
        error = ValidationError("Test")
        assert isinstance(error, PlurimError)
