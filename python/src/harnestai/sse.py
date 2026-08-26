from __future__ import annotations

import codecs
from dataclasses import dataclass
from typing import AsyncIterable, AsyncIterator, Iterable, Iterator


@dataclass(frozen=True)
class SSEMessage:
    data: str
    id: str | None = None
    event: str | None = None


class _Parser:
    def __init__(self) -> None:
        self.decoder = codecs.getincrementaldecoder("utf-8")()
        self.buffer = ""
        self.data: list[str] = []
        self.event: str | None = None
        self.id: str | None = None
        self.first = True

    def feed(self, chunk: bytes, final: bool = False) -> list[SSEMessage]:
        self.buffer += self.decoder.decode(chunk, final)
        messages: list[SSEMessage] = []
        while True:
            positions = [position for separator in ("\r", "\n") if (position := self.buffer.find(separator)) >= 0]
            if not positions:
                break
            position = min(positions)
            separator = self.buffer[position]
            if separator == "\r" and position == len(self.buffer) - 1 and not final:
                break
            line = self.buffer[:position]
            consume = 2 if separator == "\r" and self.buffer[position + 1 :].startswith("\n") else 1
            self.buffer = self.buffer[position + consume :]
            message = self._line(line)
            if message:
                messages.append(message)
        if final:
            if self.buffer:
                message = self._line(self.buffer)
                self.buffer = ""
                if message:
                    messages.append(message)
            message = self._line("")
            if message:
                messages.append(message)
        return messages

    def _line(self, line: str) -> SSEMessage | None:
        if self.first:
            self.first = False
            line = line.removeprefix("\ufeff")
        if not line:
            if not self.data:
                self.event = None
                return None
            message = SSEMessage("\n".join(self.data), self.id, self.event)
            self.data = []
            self.event = None
            return message
        if line.startswith(":"):
            return None
        field, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "data":
            self.data.append(value)
        elif field == "event":
            self.event = value
        elif field == "id" and "\0" not in value:
            self.id = value
        return None


def parse_sse(chunks: Iterable[bytes]) -> Iterator[SSEMessage]:
    parser = _Parser()
    for chunk in chunks:
        yield from parser.feed(chunk)
    yield from parser.feed(b"", True)


async def parse_sse_async(chunks: AsyncIterable[bytes]) -> AsyncIterator[SSEMessage]:
    parser = _Parser()
    async for chunk in chunks:
        for message in parser.feed(chunk):
            yield message
    for message in parser.feed(b"", True):
        yield message
