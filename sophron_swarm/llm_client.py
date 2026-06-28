"""
LLMClient – provider-agnostic abstraction for cloud model API calls.

All agent nodes depend on this interface, never on a concrete provider SDK.
The ``OpenAICompatibleClient`` concrete class supports any OpenAI-compatible
endpoint: OpenAI, Azure OpenAI, Ollama, vLLM, and similar providers.
"""
from __future__ import annotations

import inspect
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from sophron_swarm.retry import async_retry


# --------------------------------------------------------------------------- #
# Callback type aliases (used by OpenRouterClient)
# --------------------------------------------------------------------------- #
GenerationCallback = Callable[["GenerationStats"], Awaitable[None] | None]
StreamDeltaCallback = Callable[[str], Awaitable[None] | None]
ToolCallCallback = Callable[[list[dict[str, Any]]], Awaitable[None] | None]


@dataclass
class GenerationStats:
    """Telemetry surfaced by OpenRouter after (and during) a generation."""

    generation_id: str | None = None
    model: str | None = None
    model_slug: str | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    cost: float | None = None             # ``Gen-LLM-Total-Cost`` header (USD)
    latency_ms: int | None = None         # ``Gen-Processing-Milliseconds`` header
    usage: dict[str, Any] = field(default_factory=dict)
    raw_headers: dict[str, str] = field(default_factory=dict)


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _record_llm_call(
    model: str,
    messages: list[dict[str, Any]],
    raw_response: str,
) -> None:
    """Record an LLM request/response pair via the global recorder (never raises)."""
    try:
        from sophron_swarm.recorder import recorder
        recorder.record_llm_request(
            node=recorder._context.get("node", "unknown"),
            model=model,
            messages=messages,
        )
        recorder.record_llm_response(
            node=recorder._context.get("node", "unknown"),
            model=model,
            raw=raw_response,
        )
    except Exception:  # noqa: BLE001
        pass


class LLMClient(ABC):
    """Abstract interface that all LLM provider implementations must satisfy."""

    @abstractmethod
    async def complete(self, messages: list[dict[str, Any]]) -> str:
        """
        Send a messages list to the model and return the raw text response.

        Parameters
        ----------
        messages:
            OpenAI-format message list: [{"role": "...", "content": "..."}, ...]

        Returns the model's reply as a plain string.
        """


class OpenAICompatibleClient(LLMClient):
    """
    Async LLM client for any OpenAI-compatible endpoint.

    Compatible with OpenAI, Azure OpenAI, Ollama (openai shim),
    vLLM, LM Studio, and similar providers that expose the
    /v1/chat/completions API surface.

    Parameters
    ----------
    model:       Model identifier string (e.g. "gpt-4o", "llama3", "claude-3-5-sonnet").
    api_key:     Provider API key.  Use a dummy value for local endpoints.
    base_url:    Custom API base URL.  None defaults to the OpenAI public endpoint.
    max_tokens:  Maximum tokens to generate.
    temperature: Sampling temperature (lower = more deterministic; 0.0 for code).
    """

    def __init__(
        self,
        model:       str,
        api_key:     str,
        base_url:    str | None = None,
        max_tokens:  int   = 4096,
        temperature: float = 0.2,
    ) -> None:
        try:
            from openai import AsyncOpenAI  # noqa: F401
        except ImportError as exc:
            raise ImportError(
                "openai package is required: pip install openai"
            ) from exc

        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=120.0,    # 120s per-request timeout (default is 600s)
            max_retries=0,    # we handle retries ourselves in complete()
        )
        self.model       = model
        self.max_tokens  = max_tokens
        self.temperature = temperature

    async def complete(self, messages: list[dict[str, Any]]) -> str:
        response = await async_retry(max_retries=3, base_delay=2.0)(
            self._client.chat.completions.create
        )(
            model=self.model,
            messages=messages,          # type: ignore[arg-type]
            max_tokens=self.max_tokens,
            temperature=self.temperature,
        )
        raw_text = response.choices[0].message.content or ""
        _record_llm_call(self.model, messages, raw_text)
        return raw_text


class OpenRouterClient(LLMClient):
    """
    Async LLM client tailored for OpenRouter's extended feature set.

    OpenRouter speaks the standard OpenAI Chat Completions API but layers on
    extra capabilities exposed through the request ``extra_body`` and the
    response headers/body:

    * **Model routing & fallbacks** – pass several models and let OpenRouter
      fall back automatically on rate-limit or availability errors.
    * **Provider preferences** – pin specific providers, quantizations, etc.
    * **Prompt transforms** – server-side compression (e.g. ``"middle-out"``).
    * **Plugins** – web search and other first-party tools.
    * **Reasoning effort** – control the thinking budget for reasoning models.
    * **Data-collection policy** – opt out of provider training (``"deny"``).
    * **Generation telemetry** – cost, latency and token usage surfaced via
      :class:`GenerationStats` and delivered to optional callbacks.

    Parameters
    ----------
    model:
        Primary model identifier (e.g. ``"anthropic/claude-3.5-sonnet"``).
    api_key:
        OpenRouter API key.
    max_tokens, temperature:
        Standard generation parameters.
    fallback_models:
        Extra model ids used when ``route="fallback"``.
    route:
        Routing strategy; set to ``"fallback"`` to enable model fallbacks.
    provider:
        OpenRouter provider-preferences dict
        (``order``, ``allow_fallbacks``, ``require_parameters``,
        ``quantizations``, ``ignore``, ``only`` …).
    transforms:
        Server-side prompt transforms, e.g. ``["middle-out"]``.
    plugins:
        Plugin specs, e.g. ``[{"id": "web"}]`` for web search.
    reasoning_effort:
        ``"low"`` | ``"medium"`` | ``"high"`` for reasoning models.
    data_collection:
        ``"allow"`` | ``"deny"`` training-data policy.
    response_format:
        JSON-schema / structured-output spec passed through to the model.
    site_url, app_name:
        App attribution sent via the ``HTTP-Referer`` / ``X-Title`` headers
        (recommended by OpenRouter for ranking & analytics).
    on_generation:
        Async or sync callback fired with :class:`GenerationStats` once a
        request finishes.
    on_stream_delta:
        Callback fired for each streamed text delta.
    on_tool_call:
        Callback fired when the model emits tool/function calls.
    """

    BASE_URL = "https://openrouter.ai/api/v1"

    def __init__(
        self,
        model:          str,
        api_key:        str,
        max_tokens:     int   = 4096,
        temperature:    float = 0.2,
        *,
        fallback_models:   list[str] | None = None,
        route:             str | None = None,
        provider:          dict[str, Any] | None = None,
        transforms:        list[str] | None = None,
        plugins:           list[dict[str, Any]] | None = None,
        reasoning_effort:  str | None = None,
        data_collection:   str | None = None,
        response_format:   dict[str, Any] | None = None,
        site_url:          str | None = None,
        app_name:          str | None = None,
        on_generation:     GenerationCallback | None = None,
        on_stream_delta:   StreamDeltaCallback | None = None,
        on_tool_call:      ToolCallCallback | None = None,
    ) -> None:
        try:
            from openai import AsyncOpenAI  # noqa: F401
        except ImportError as exc:
            raise ImportError(
                "openai package is required: pip install openai"
            ) from exc

        from openai import AsyncOpenAI

        # OpenRouter recommends app attribution for ranking/analytics.
        headers: dict[str, str] = {}
        if site_url:
            headers["HTTP-Referer"] = site_url
        if app_name:
            headers["X-Title"] = app_name

        self._client = AsyncOpenAI(
            api_key=api_key,
            base_url=self.BASE_URL,
            timeout=120.0,    # 120s per-request timeout
            max_retries=0,    # we handle retries ourselves in complete()
        )
        self.model          = model
        self.max_tokens     = max_tokens
        self.temperature    = temperature

        # OpenRouter-specific request options.
        self._fallback_models  = fallback_models
        self._route            = route
        self._provider         = provider
        self._transforms       = transforms
        self._plugins          = plugins
        self._reasoning_effort = reasoning_effort
        self._data_collection  = data_collection
        self._response_format  = response_format
        self._extra_headers    = headers or None

        # Callbacks.
        self._on_generation  = on_generation
        self._on_stream_delta = on_stream_delta
        self._on_tool_call   = on_tool_call

    # ------------------------------------------------------------------ #
    # LLMClient interface
    # ------------------------------------------------------------------ #
    async def complete(self, messages: list[dict[str, Any]]) -> str:
        """
        Run a (non-streaming) completion, capturing OpenRouter telemetry and
        dispatching the registered callbacks.  Returns the assistant text.
        """
        raw = await async_retry(max_retries=3, base_delay=2.0)(
            self._client.chat.completions.with_raw_response.create
        )(
            model=self.model,
            messages=messages,          # type: ignore[arg-type]
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            response_format=self._response_format,     # type: ignore[arg-type]
            extra_body=self._build_extra_body(),
            extra_headers=self._extra_headers,
        )
        completion = raw.parse()
        stats = self._stats_from(raw.headers, completion)
        await self._invoke(self._on_generation, stats)

        message = completion.choices[0].message
        tool_calls = getattr(message, "tool_calls", None)
        if tool_calls:
            await self._invoke(
                self._on_tool_call, [tc.model_dump() for tc in tool_calls]
            )
        raw_text = message.content or ""
        _record_llm_call(self.model, messages, raw_text)
        return raw_text

    # ------------------------------------------------------------------ #
    # Streaming (OpenRouterClient extension, not part of the ABC)
    # ------------------------------------------------------------------ #
    async def complete_stream(self, messages: list[dict[str, Any]]) -> str:
        """
        Stream a completion token-by-token.  Fires ``on_stream_delta`` for each
        chunk and a final ``on_generation`` (with token usage when available).
        Cost/latency headers are not returned for streamed responses.
        """
        stream = await async_retry(max_retries=3, base_delay=2.0)(
            self._client.chat.completions.create
        )(
            model=self.model,
            messages=messages,          # type: ignore[arg-type]
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            response_format=self._response_format,     # type: ignore[arg-type]
            stream=True,
            stream_options={"include_usage": True},
            extra_body=self._build_extra_body(),
            extra_headers=self._extra_headers,
        )

        parts: list[str] = []
        usage: Any = None
        model_slug: str | None = None
        tool_calls: list[dict[str, Any]] = []

        async for chunk in stream:
            usage = getattr(chunk, "usage", None) or usage
            model_slug = getattr(chunk, "model", None) or model_slug
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta

            if getattr(delta, "tool_calls", None):
                for tc in delta.tool_calls:
                    tool_calls.append(tc.model_dump())

            text = delta.content or ""
            if text:
                parts.append(text)
                await self._invoke(self._on_stream_delta, text)

        if tool_calls:
            await self._invoke(self._on_tool_call, tool_calls)

        stats = GenerationStats(
            model=model_slug,
            model_slug=model_slug,
            prompt_tokens=getattr(usage, "prompt_tokens", None) if usage else None,
            completion_tokens=getattr(usage, "completion_tokens", None) if usage else None,
            total_tokens=getattr(usage, "total_tokens", None) if usage else None,
            usage=usage.model_dump() if usage else {},
        )
        await self._invoke(self._on_generation, stats)
        return "".join(parts)

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #
    def _build_extra_body(self) -> dict[str, Any]:
        """Assemble the OpenRouter-specific ``extra_body`` payload."""
        body: dict[str, Any] = {}
        if self._fallback_models:
            body["models"] = [self.model, *self._fallback_models]
        if self._route:
            body["route"] = self._route
        if self._provider is not None:
            body["provider"] = self._provider
        if self._transforms:
            body["transforms"] = self._transforms
        if self._plugins:
            body["plugins"] = self._plugins
        if self._reasoning_effort:
            body["reasoning"] = {"effort": self._reasoning_effort}
        if self._data_collection:
            body["data_collection"] = self._data_collection
        return body

    def _stats_from(self, headers: Any, completion: Any) -> "GenerationStats":
        """Build :class:`GenerationStats` from a raw response + its headers."""
        def header(name: str) -> str | None:
            if headers is None:
                return None
            try:
                return headers.get(name)
            except AttributeError:
                return headers.get(name) if isinstance(headers, dict) else None

        usage = getattr(completion, "usage", None)
        return GenerationStats(
            generation_id=getattr(completion, "id", None),
            model=getattr(completion, "model", None),
            model_slug=(header("X-Openrouter-Model")
                        or getattr(completion, "model_slug", None)),
            prompt_tokens=getattr(usage, "prompt_tokens", None) if usage else None,
            completion_tokens=getattr(usage, "completion_tokens", None) if usage else None,
            total_tokens=getattr(usage, "total_tokens", None) if usage else None,
            cost=_to_float(header("Gen-LLM-Total-Cost")),
            latency_ms=_to_int(header("Gen-Processing-Milliseconds")),
            usage=usage.model_dump() if usage else {},
            raw_headers=dict(headers) if headers is not None else {},
        )

    @staticmethod
    async def _invoke(callback: Callable[..., Any] | None, *args: Any) -> None:
        """Invoke a callback that may be sync or async."""
        if callback is None:
            return
        result = callback(*args)
        if inspect.isawaitable(result):
            await result