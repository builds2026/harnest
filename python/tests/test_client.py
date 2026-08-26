import json
from pathlib import Path

import httpx
import pytest
from pydantic import TypeAdapter

from harnestai import (
    AsyncHarnestClient,
    CreateRunRequest,
    HarnestClient,
    IdempotencyKey,
    InteractionRequest,
    InteractionResponse,
    PermissionScope,
    RunCommand,
    SnapshotResponse,
    WireEnvelope,
    parse_sse,
)


ENVELOPE = {
    "protocolVersion": "1.0",
    "eventId": "event-2",
    "runId": "run-1",
    "sequence": 2,
    "time": "2026-08-25T00:00:00.000Z",
    "type": "run.completed",
    "data": {"output": "done"},
}


def test_chunked_sse_parser():
    messages = list(parse_sse([b": ping\r", b"\nid: 7\r\ndata: one\r\nda", b"ta: two\r\n\r\n"]))
    assert messages == [messages[0]]
    assert (messages[0].id, messages[0].data) == ("7", "one\ntwo")


def test_typescript_golden_fixture_with_strict_alias_models():
    fixture = json.loads((Path(__file__).parents[2] / "packages/protocol/fixtures/v1.json").read_text())
    assert TypeAdapter(IdempotencyKey).validate_python(fixture["idempotencyKey"]) == fixture["idempotencyKey"]
    assert CreateRunRequest.model_validate(fixture["createRun"]).to_dict() == fixture["createRun"]
    assert SnapshotResponse.model_validate(fixture["snapshotResponse"]).to_dict() == fixture["snapshotResponse"]
    assert WireEnvelope.model_validate(fixture["event"]).to_dict() == fixture["event"]
    assert InteractionRequest.model_validate(fixture["interaction"]).to_dict() == fixture["interaction"]
    assert InteractionRequest(
        **{key: value for key, value in fixture["interaction"].items() if key != "schema"},
        schema=fixture["interaction"]["schema"],
    ).input_schema == fixture["interaction"]["schema"]
    response = InteractionResponse.model_validate(fixture["command"]["response"])
    assert response.to_dict() == fixture["command"]["response"]
    assert TypeAdapter(RunCommand).validate_python(fixture["command"]).to_dict() == fixture["command"]
    assert PermissionScope.model_validate(fixture["permission"]["scope"]).to_dict() == fixture["permission"]["scope"]
    assert InteractionResponse(
        interaction_id="approval-1",
        checkpoint_digest="c29tZS1jaGVja3BvaW50",
        action="submit",
    ).to_dict()["interactionId"] == "approval-1"
    compatible = {**fixture["event"], "protocolVersion": "1.7", "additive": True}
    assert WireEnvelope.model_validate(compatible).protocol_version == "1.7"
    with pytest.raises(ValueError):
        WireEnvelope.model_validate({**compatible, "protocolVersion": "2.0"})
    with pytest.raises(ValueError):
        CreateRunRequest.model_validate({
            "input": "unsafe", "context": {"contextRef": "opaque", "token": "must-not-cross"},
        })
    with pytest.raises(ValueError):
        TypeAdapter(RunCommand).validate_python({"type": "unknown"})
    with pytest.raises(ValueError):
        TypeAdapter(RunCommand).validate_python({
            **fixture["command"], "token": "must-not-cross",
        })
    resolved = {**fixture["event"], "type": "interaction.resolved", "data": {
        "interactionId": "approval-1", "action": "submit", "permission": "allow_once",
    }}
    assert WireEnvelope.model_validate(resolved).data == resolved["data"]


def test_sync_client_routes_and_cursor():
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/events"):
            return httpx.Response(200, text=f"id: 2\nevent: run.completed\ndata: {json.dumps(ENVELOPE)}\n\n")
        if request.url.path.endswith("/runs"):
            return httpx.Response(202, json={"runId": "run-1"})
        if request.url.path.endswith("/snapshot"):
            return httpx.Response(200, json={"ok": True, "snapshot": {"status": "paused"}, "active": True})
        return httpx.Response(200, json={"ok": True})

    http = httpx.Client(base_url="https://example.test/api/", transport=httpx.MockTransport(handle))
    client = HarnestClient("https://unused.test", http_client=http)
    assert client.create("hello", idempotency_key="retry/client:request-1", context={
        "contextRef": "ctx_opaque", "revisions": {"conversation": "r2"},
        "attachments": [{
            "ref": "file_1", "name": "brief.pdf", "mimeType": "application/pdf", "size": 4,
            "sha256": "a" * 64,
        }],
    }).run_id == "run-1"
    assert client.wait("run-1", after=1) == {"output": "done"}
    assert client.snapshot_state("run-1").to_dict() == {"snapshot": {"status": "paused"}, "active": True}
    client.respond("run-1", InteractionResponse(
        interaction_id="approval-1",
        checkpoint_digest="c29tZS1jaGVja3BvaW50",
        action="submit",
        permission="allow_once",
    ))
    client.cancel("run-1")
    assert [(request.method, request.url.path) for request in requests] == [
        ("POST", "/api/v1/runs"),
        ("GET", "/api/v1/runs/run-1/events"),
        ("GET", "/api/v1/runs/run-1/snapshot"),
        ("POST", "/api/v1/runs/run-1/commands"),
        ("DELETE", "/api/v1/runs/run-1"),
    ]
    assert requests[1].headers["last-event-id"] == "1"
    assert requests[0].headers["idempotency-key"] == "retry/client:request-1"
    assert requests[1].url.params["after"] == "1"
    create_body = json.loads(requests[0].content)
    assert create_body["context"] == {
        "contextRef": "ctx_opaque", "revisions": {"conversation": "r2"},
        "attachments": [{
            "ref": "file_1", "name": "brief.pdf", "mimeType": "application/pdf", "size": 4,
            "sha256": "a" * 64,
        }],
    }
    with pytest.raises(ValueError):
        client.create("hello", idempotency_key="")


@pytest.mark.asyncio
async def test_async_client_wait():
    requests = []

    async def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/runs"):
            return httpx.Response(202, json={"runId": "run-1"})
        if request.url.path.endswith("/snapshot"):
            return httpx.Response(200, json={"snapshot": {"status": "paused"}, "active": False})
        return httpx.Response(200, text=f"data: {json.dumps(ENVELOPE)}\n\n")

    http = httpx.AsyncClient(base_url="https://example.test/api/", transport=httpx.MockTransport(handle))
    client = AsyncHarnestClient("https://unused.test", http_client=http)
    created = await client.create("hello", context={"contextRef": "ctx_async"}, idempotency_key="retry/async:request-1")
    assert created.run_id == "run-1"
    assert json.loads(requests[0].content) == {"input": "hello", "context": {"contextRef": "ctx_async"}}
    assert requests[0].headers["idempotency-key"] == "retry/async:request-1"
    assert (await client.snapshot_state("run-1")).active is False
    assert await client.wait("run-1") == {"output": "done"}
    await http.aclose()
