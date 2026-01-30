"""
Exception classes for the Plurum SDK
"""

from typing import Optional


class PlurimError(Exception):
    """Base exception for all Plurum errors"""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class AuthenticationError(PlurimError):
    """Raised when API key is missing or invalid"""

    def __init__(self, message: str = "Invalid or missing API key"):
        super().__init__(message, status_code=401)


class NotFoundError(PlurimError):
    """Raised when a resource is not found"""

    def __init__(self, message: str = "Resource not found"):
        super().__init__(message, status_code=404)


class RateLimitError(PlurimError):
    """Raised when rate limit is exceeded"""

    def __init__(self, message: str = "Rate limit exceeded"):
        super().__init__(message, status_code=429)


class ValidationError(PlurimError):
    """Raised when request validation fails"""

    def __init__(self, message: str):
        super().__init__(message, status_code=422)
