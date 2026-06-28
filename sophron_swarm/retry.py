"""
Retry utilities – resilient error handling for transient failures.

Provides async/sync retry decorators and a transient-error classifier used by
LLM clients, the graph loop, and other I/O-bound components.

Transient (retriable) errors include:
  - Network timeouts and connection resets
  - HTTP 429 (rate limit), 500, 502, 503, 504
  - asyncio.TimeoutError
  - Connection errors from httpx/httpcore

Fatal (non-retriable) errors propagate immediately:
  - Authentication failures (401/403)
  - Invalid request schema (400)
  - ImportError, AttributeError, etc.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import random
from typing import Any, Awaitable, Callable, ParamSpec, TypeVar

log = logging.getLogger(__name__)

P = ParamSpec("P")
T = TypeVar("T")


# --------------------------------------------------------------------------- #
# Transient error classifier
# --------------------------------------------------------------------------- #
def is_transient_error(exc: BaseException) -> bool:
    """
    Return True if ``exc`` represents a transient, retriable failure.

    Inspects the exception type, message, and (for openai SDK errors) the
    HTTP status code attribute.
    """
    # TimeoutError / asyncio.TimeoutError
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return True

    # Connection-level errors from httpx / httpcore / aiohttp
    exc_name = type(exc).__name__
    if exc_name in (
        "ConnectError", "ConnectTimeout", "ReadError", "ReadTimeout",
        "WriteError", "WriteTimeout", "PoolTimeout", "NetworkError",
        "RemoteProtocolError", "LocalProtocolError",
        "APIConnectionError", "APITimeoutError", "InternalError",
    ):
        return True

    # openai / openrouter API status errors — inspect status code
    status_code = getattr(exc, "status_code", None)
    if status_code is not None:
        try:
            code = int(status_code)
            # 429 = rate limit, 5xx = server errors → retriable
            if code == 429 or 500 <= code < 600:
                return True
            # 408 Request Timeout
            if code == 408:
                return True
        except (TypeError, ValueError):
            pass

    # Fallback: check message text for known transient signals
    msg = str(exc).lower()
    transient_signals = (
        "timed out", "timeout", "connection reset", "connection refused",
        "temporarily unavailable", "service unavailable", "rate limit",
        "too many requests", "overloaded", "internal server error",
        "bad gateway", "gateway timeout", "retry",
    )
    if any(signal in msg for signal in transient_signals):
        return True

    return False


# --------------------------------------------------------------------------- #
# Async retry decorator
# --------------------------------------------------------------------------- #
def async_retry(
    max_retries: int = 3,
    base_delay: float = 2.0,
    max_delay: float = 30.0,
    transient_check: Callable[[BaseException], bool] | None = None,
) -> Callable[[Callable[P, Awaitable[T]]], Callable[P, Awaitable[T]]]:
    """
    Decorator that retries an async function on transient errors.

    Uses exponential backoff with jitter:
        delay = min(max_delay, base_delay * 2^attempt) + random(0, 1)

    Parameters
    ----------
    max_retries:
        Maximum number of retry attempts (not counting the initial call).
    base_delay:
        Initial delay in seconds before the first retry.
    max_delay:
        Upper bound on the delay between retries.
    transient_check:
        Optional callable to classify exceptions.  Defaults to
        :func:`is_transient_error`.
    """
    check = transient_check or is_transient_error

    def decorator(fn: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[T]]:
        @functools.wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
            last_exc: BaseException | None = None
            for attempt in range(max_retries + 1):
                try:
                    return await fn(*args, **kwargs)
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    if not check(exc) or attempt == max_retries:
                        raise
                    delay = min(max_delay, base_delay * (2 ** attempt))
                    delay += random.uniform(0, 1)  # jitter
                    log.warning(
                        "%s: transient error (attempt %d/%d): %s – "
                        "retrying in %.1fs",
                        getattr(fn, "__name__", "function"),
                        attempt + 1, max_retries, exc, delay,
                    )
                    await asyncio.sleep(delay)
            # Should never reach here, but satisfy type checker
            if last_exc:
                raise last_exc
            raise RuntimeError("async_retry: exhausted retries without exception")
        return wrapper
    return decorator


# --------------------------------------------------------------------------- #
# Sync retry helper (for non-async operations like sandbox subprocess)
# --------------------------------------------------------------------------- #
def retry_sync(
    fn: Callable[P, T],
    *args: P.args,
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 15.0,
    transient_check: Callable[[BaseException], bool] | None = None,
    **kwargs: P.kwargs,
) -> T:
    """
    Call ``fn`` with retries on transient errors (synchronous version).

    Returns the result on success, or re-raises the last exception if all
    retries are exhausted or a fatal error occurs.
    """
    check = transient_check or is_transient_error
    last_exc: BaseException | None = None
    for attempt in range(max_retries + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if not check(exc) or attempt == max_retries:
                raise
            delay = min(max_delay, base_delay * (2 ** attempt))
            delay += random.uniform(0, 1)
            log.warning(
                "%s: transient error (attempt %d/%d): %s – retrying in %.1fs",
                getattr(fn, "__name__", "function"),
                attempt + 1, max_retries, exc, delay,
            )
            import time
            time.sleep(delay)
    if last_exc:
        raise last_exc
    raise RuntimeError("retry_sync: exhausted retries without exception")
