from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Dict, List, Optional

import websockets

from .messages import Command, CommandType, ForwardNode

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 10.0


class NapcatRelayClient:
    def __init__(self, url: Optional[str] = None, timeout: Optional[float] = None):
        self.url = url or _env_url()
        self.timeout = timeout or _parse_timeout(os.getenv("NAPCAT_TIMEOUT", ""))

    async def send_command(self, command: Command) -> Dict[str, Any]:
        payload = json.dumps(command.as_dict(), ensure_ascii=False)
        logger.debug("Connecting to Napcat websocket url=%s action=%s", self.url, command.action.value)
        async with websockets.connect(self.url, max_size=None) as ws:
            await ws.send(payload)
            logger.debug("Sent command echo=%s action=%s", command.echo, command.action.value)
            try:
                return await self._wait_for_response(ws, command.echo)
            except asyncio.TimeoutError:
                logger.warning("Napcat response timed out after %.1fs", self.timeout)
                return {"status": "timeout", "echo": command.echo}
            except Exception as exc:  # noqa: BLE001
                logger.exception("Napcat websocket error echo=%s: %s", command.echo, exc)
                raise

    async def _wait_for_response(self, ws, echo: str) -> Dict[str, Any]:
        """Skip non-command frames (e.g., lifecycle meta_events) until matching echo arrives."""
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=self.timeout)
            logger.debug("Received frame bytes=%d", len(raw))
            try:
                data = json.loads(raw)
            except Exception:
                logger.debug("Ignoring non-JSON frame")
                continue

            if data.get("post_type") == "meta_event":
                logger.debug("Ignoring meta_event frame")
                continue

            if data.get("echo") and data.get("echo") != echo:
                logger.debug("Ignoring frame with mismatched echo=%s", data.get("echo"))
                continue

            return data


async def send_group_message(
    client: NapcatRelayClient, group_id: str, message: List[Dict[str, Any]]
) -> Dict[str, Any]:
    params = {"group_id": str(group_id), "message": message}
    command = Command(CommandType.SEND_GROUP_MSG, params)
    return await client.send_command(command)


async def send_group_forward_message(
    client: NapcatRelayClient, group_id: str, nodes: List[ForwardNode]
) -> Dict[str, Any]:
    params = {"group_id": str(group_id), "messages": [node.as_dict() for node in nodes]}
    command = Command(CommandType.SEND_GROUP_FORWARD_MSG, params)
    return await client.send_command(command)


async def send_private_message(
    client: NapcatRelayClient, user_id: str, message: List[Dict[str, Any]]
) -> Dict[str, Any]:
    params = {"user_id": str(user_id), "message": message}
    command = Command(CommandType.SEND_PRIVATE_MSG, params)
    return await client.send_command(command)


def _parse_timeout(raw: str) -> float:
    if not raw:
        return DEFAULT_TIMEOUT
    try:
        value = float(raw)
        return value if value > 0 else DEFAULT_TIMEOUT
    except ValueError:
        return DEFAULT_TIMEOUT


def _env_url() -> str:
    url = os.getenv("NAPCAT_URL")
    if not url:
        raise ValueError("Napcat URL not set; supply url or set NAPCAT_URL")
    return url
