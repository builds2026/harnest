from __future__ import annotations

import json
from typing import Any, AsyncIterator, Iterator, Mapping

import httpx
from pydantic import TypeAdapter

from .models import CreateRunContext, CreateRunRequest, CreateRunResponse, IdempotencyKey, InteractionResponse, RunCommand, SnapshotResponse, WireEnvelope
from .sse import parse_sse, parse_sse_async


class HarnestError(RuntimeError):
    def __init__(self, message: str, status: int = 0, code: str | None = None, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details


_IDEMPOTENCY_KEY = TypeAdapter(IdempotencyKey)
_RUN_COMMAND = TypeAdapter(RunCommand)


def _error(response: httpx.Response) -> HarnestError:
    try:
        details = response.json()
    except ValueError:
        details = None
    record = details if isinstance(details, dict) else {}
    nested = record.get("error") if isinstance(record.get("error"), dict) else {}
    message = record.get("error") if isinstance(record.get("error"), str) else nested.get("message") or record.get("message")
    return HarnestError(message or f"{response.status_code} {response.reason_phrase}", response.status_code, nested.get("code") or record.get("code"), details)


def _envelope(message: str) -> WireEnvelope:
    try:
        value = json.loads(message)
    except ValueError as cause:
        raise HarnestError("Event data is not valid JSON", code="INVALID_EVENT") from cause
    if not isinstance(value, dict):
        raise HarnestError("Event data is not an object", code="INVALID_EVENT")
    try:
        return WireEnvelope.from_dict(value)
    except (KeyError, TypeError, ValueError) as cause:
        raise HarnestError("Event envelope is invalid", code="INVALID_EVENT", details=value) from cause


class HarnestClient:
    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | httpx.Timeout = 30.0,
        http_client: httpx.Client | None = None,
    ) -> None:
        merged = dict(headers or {})
        if token:
            merged["Authorization"] = f"Bearer {token}"
        self._owns_client = http_client is None
        self._client = http_client or httpx.Client(base_url=base_url.rstrip("/") + "/", headers=merged, timeout=timeout)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "HarnestClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def create(
        self,
        input: Any,
        *,
        resume_run_id: str | None = None,
        context: CreateRunContext | Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> CreateRunResponse:
        body = CreateRunRequest(input=input, resume_run_id=resume_run_id, context=context).to_dict()
        headers = {"Idempotency-Key": _IDEMPOTENCY_KEY.validate_python(idempotency_key)} if idempotency_key is not None else None
        value = self._json("POST", "v1/runs", json=body, headers=headers)
        return CreateRunResponse.model_validate({key: value[key] for key in ("runId", "events", "snapshot") if key in value})

    def events(self, run_id: str, *, after: int | None = None, last_event_id: str | None = None) -> Iterator[WireEnvelope]:
        headers = {"Accept": "text/event-stream"}
        cursor = last_event_id if last_event_id is not None else str(after) if after is not None else None
        if cursor is not None:
            headers["Last-Event-ID"] = cursor
        with self._client.stream("GET", f"v1/runs/{run_id}/events", params={"after": after} if after is not None else None, headers=headers) as response:
            if response.is_error:
                raise _error(response)
            for message in parse_sse(response.iter_bytes()):
                yield _envelope(message.data)

    def snapshot(self, run_id: str) -> dict[str, Any]:
        return self._json("GET", f"v1/runs/{run_id}/snapshot")["snapshot"]

    def snapshot_state(self, run_id: str) -> SnapshotResponse:
        return SnapshotResponse.model_validate(self._json("GET", f"v1/runs/{run_id}/snapshot"))

    def command(self, run_id: str, command: Mapping[str, Any]) -> None:
        self._json("POST", f"v1/runs/{run_id}/commands", json=_RUN_COMMAND.validate_python(command).to_dict())

    def respond(self, run_id: str, response: InteractionResponse | Mapping[str, Any]) -> None:
        value = response.to_dict() if isinstance(response, InteractionResponse) else dict(response)
        self.command(run_id, {"type": "interaction.response", "response": value})

    def cancel(self, run_id: str) -> None:
        self._json("DELETE", f"v1/runs/{run_id}")

    def wait(self, run_id: str, *, after: int | None = None, last_event_id: str | None = None) -> Any:
        for envelope in self.events(run_id, after=after, last_event_id=last_event_id):
            if envelope.type in ("run.failed", "run.cancelled"):
                data = envelope.data if isinstance(envelope.data, dict) else {}
                fallback = "Run cancelled" if envelope.type == "run.cancelled" else "Run failed"
                code = data.get("code") or ("RUN_CANCELLED" if envelope.type == "run.cancelled" else None)
                raise HarnestError(data.get("message", fallback), code=code, details=data)
            if envelope.type == "run.completed":
                return envelope.data
        raise HarnestError("Event stream ended before the run completed", code="RUN_INCOMPLETE")

    def _json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        headers = {"Accept": "application/json", **(kwargs.pop("headers", None) or {})}
        response = self._client.request(method, path, headers=headers, **kwargs)
        if response.is_error:
            raise _error(response)
        if not response.content:
            return {"ok": True}
        value = response.json()
        if not isinstance(value, dict):
            raise HarnestError("JSON response is not an object", response.status_code)
        return value


class AsyncHarnestClient:
    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | httpx.Timeout = 30.0,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        merged = dict(headers or {})
        if token:
            merged["Authorization"] = f"Bearer {token}"
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(base_url=base_url.rstrip("/") + "/", headers=merged, timeout=timeout)

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> "AsyncHarnestClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def create(
        self,
        input: Any,
        *,
        resume_run_id: str | None = None,
        context: CreateRunContext | Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> CreateRunResponse:
        body = CreateRunRequest(input=input, resume_run_id=resume_run_id, context=context).to_dict()
        headers = {"Idempotency-Key": _IDEMPOTENCY_KEY.validate_python(idempotency_key)} if idempotency_key is not None else None
        value = await self._json("POST", "v1/runs", json=body, headers=headers)
        return CreateRunResponse.model_validate({key: value[key] for key in ("runId", "events", "snapshot") if key in value})

    async def events(self, run_id: str, *, after: int | None = None, last_event_id: str | None = None) -> AsyncIterator[WireEnvelope]:
        headers = {"Accept": "text/event-stream"}
        cursor = last_event_id if last_event_id is not None else str(after) if after is not None else None
        if cursor is not None:
            headers["Last-Event-ID"] = cursor
        async with self._client.stream("GET", f"v1/runs/{run_id}/events", params={"after": after} if after is not None else None, headers=headers) as response:
            if response.is_error:
                raise _error(response)
            async for message in parse_sse_async(response.aiter_bytes()):
                yield _envelope(message.data)

    async def snapshot(self, run_id: str) -> dict[str, Any]:
        return (await self._json("GET", f"v1/runs/{run_id}/snapshot"))["snapshot"]

    async def snapshot_state(self, run_id: str) -> SnapshotResponse:
        return SnapshotResponse.model_validate(await self._json("GET", f"v1/runs/{run_id}/snapshot"))

    async def command(self, run_id: str, command: Mapping[str, Any]) -> None:
        await self._json("POST", f"v1/runs/{run_id}/commands", json=_RUN_COMMAND.validate_python(command).to_dict())

    async def respond(self, run_id: str, response: InteractionResponse | Mapping[str, Any]) -> None:
        value = response.to_dict() if isinstance(response, InteractionResponse) else dict(response)
        await self.command(run_id, {"type": "interaction.response", "response": value})

    async def cancel(self, run_id: str) -> None:
        await self._json("DELETE", f"v1/runs/{run_id}")

    async def wait(self, run_id: str, *, after: int | None = None, last_event_id: str | None = None) -> Any:
        async for envelope in self.events(run_id, after=after, last_event_id=last_event_id):
            if envelope.type in ("run.failed", "run.cancelled"):
                data = envelope.data if isinstance(envelope.data, dict) else {}
                fallback = "Run cancelled" if envelope.type == "run.cancelled" else "Run failed"
                code = data.get("code") or ("RUN_CANCELLED" if envelope.type == "run.cancelled" else None)
                raise HarnestError(data.get("message", fallback), code=code, details=data)
            if envelope.type == "run.completed":
                return envelope.data
        raise HarnestError("Event stream ended before the run completed", code="RUN_INCOMPLETE")

    async def _json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        headers = {"Accept": "application/json", **(kwargs.pop("headers", None) or {})}
        response = await self._client.request(method, path, headers=headers, **kwargs)
        if response.is_error:
            raise _error(response)
        if not response.content:
            return {"ok": True}
        value = response.json()
        if not isinstance(value, dict):
            raise HarnestError("JSON response is not an object", response.status_code)
        return value
