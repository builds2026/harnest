from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Union

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

JsonObject = dict[str, Any]


def _iso_timestamp(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include a UTC offset")
    return value


Timestamp = Annotated[str, AfterValidator(_iso_timestamp)]
IdempotencyKey = Annotated[str, Field(min_length=1, max_length=512, pattern=r"^[^\x00-\x1F\x7F]+$")]


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, strict=True, extra="forbid")

    def to_dict(self) -> JsonObject:
        return self.model_dump(by_alias=True, exclude_none=True)


class WireEnvelope(Model):
    model_config = ConfigDict(extra="allow")
    protocol_version: str = Field(pattern=r"^1\.\d+$")
    event_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    run_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    sequence: int = Field(ge=0)
    time: Timestamp
    type: str = Field(min_length=1, max_length=128, pattern=r"^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$")
    data: Any

    @model_validator(mode="after")
    def validate_typed_data(self) -> "WireEnvelope":
        schema = InteractionRequest if self.type == "interaction.requested" else InteractionResolved if self.type == "interaction.resolved" else None
        if schema:
            schema.model_validate(self.data)
        elif self.type == "run.snapshot" and not isinstance(self.data, dict):
            raise ValueError("run.snapshot data must be an object")
        return self

    @classmethod
    def from_dict(cls, value: JsonObject) -> "WireEnvelope":
        return cls.model_validate(value)


class Requester(Model):
    kind: Literal["harness", "agent", "tool", "mcp"]
    id: str = Field(min_length=1, max_length=512)


class Checkpoint(Model):
    revision: int = Field(ge=0)
    sequence: int = Field(ge=0)
    digest: str = Field(min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")


class InteractionRequest(Model):
    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    run_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    node_id: str = Field(min_length=1, max_length=512)
    task_id: str | None = Field(default=None, min_length=1, max_length=512)
    agent_id: str | None = Field(default=None, min_length=1, max_length=512)
    kind: Literal["select", "input", "form", "file", "oauth", "permission"]
    requester: Requester
    title: str = Field(min_length=1, max_length=512)
    message: str = Field(min_length=1, max_length=65_536)
    blocking: Literal["task", "run"]
    input_schema: JsonObject | None = Field(default=None, alias="schema")
    data: Any = None
    checkpoint: Checkpoint
    created_at: Timestamp
    expires_at: Timestamp | None = None

    @classmethod
    def from_dict(cls, value: JsonObject) -> "InteractionRequest":
        return cls.model_validate(value)


class InteractionResponse(Model):
    interaction_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    checkpoint_digest: str = Field(min_length=16, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")
    action: Literal["submit", "decline", "cancel"]
    value: Any = None
    permission: Literal["allow_once", "allow_for_run", "allow_always", "deny"] | None = None


class InteractionResolved(Model):
    interaction_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    action: Literal["submit", "decline", "cancel"]
    permission: Literal["allow_once", "allow_for_run", "allow_always", "deny"] | None = None


class MessageTarget(Model):
    kind: Literal["run", "team", "agent"]
    id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class PlanOperation(Model):
    op: Literal["add", "update", "cancel"]
    task_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    goal: str | None = Field(default=None, min_length=1, max_length=65_536)
    assignee: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    depends_on: list[Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")]] | None = Field(default=None, max_length=64)


class MessageCommand(Model):
    command_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    type: Literal["message"]
    target: MessageTarget
    content: str = Field(min_length=1, max_length=65_536)
    correlation_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class TaskDirectiveCommand(Model):
    command_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    type: Literal["task-directive"]
    task_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    instruction: str = Field(min_length=1, max_length=65_536)


class PlanPatchCommand(Model):
    command_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    type: Literal["plan-patch"]
    base_revision: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=65_536)
    operations: list[PlanOperation] = Field(min_length=1, max_length=64)


class CancelCommand(Model):
    command_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    type: Literal["cancel"]
    scope: Literal["run", "task", "agent"]
    target_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class InteractionResponseCommand(Model):
    command_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    type: Literal["interaction.response"]
    response: InteractionResponse


RunCommand = Annotated[
    Union[MessageCommand, TaskDirectiveCommand, PlanPatchCommand, CancelCommand, InteractionResponseCommand],
    Field(discriminator="type"),
]


class PermissionScope(Model):
    harness_id: str = Field(min_length=1, max_length=512)
    tool_id: str = Field(min_length=1, max_length=512)
    capability: Literal["network", "process", "workspace-write"]
    connection_id: str | None = Field(default=None, min_length=1, max_length=512)
    resource: str | None = Field(default=None, min_length=1, max_length=512)


class Permission(Model):
    scope: PermissionScope
    effect: Literal["allow_for_run", "allow_always", "deny"]
    created_at: Timestamp
    expires_at: Timestamp | None = None


class CreateRunResponse(Model):
    run_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    events: str | None = None
    snapshot: str | None = None


class SnapshotResponse(Model):
    model_config = ConfigDict(extra="ignore")
    snapshot: JsonObject
    active: bool


Revision = str | int | float


class ExternalAttachment(Model):
    ref: str = Field(min_length=1, max_length=512)
    name: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=127, pattern=r"^[\w.+-]+/[\w.+-]+$")
    size: int = Field(ge=0, le=64 * 1_048_576)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class ContextRevisions(Model):
    conversation: Revision | None = None
    memory: Revision | None = None
    pkm: Revision | None = None


class CreateRunContext(Model):
    context_ref: str = Field(min_length=1, max_length=512)
    revisions: ContextRevisions | None = None
    attachments: list[ExternalAttachment] | None = Field(default=None, max_length=32)


class CreateRunRequest(Model):
    input: Any
    resume_run_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    context: CreateRunContext | None = None
