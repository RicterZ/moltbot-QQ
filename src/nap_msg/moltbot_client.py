from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional

from moltbot import GatewayError, GatewayWebSocketClient

logger = logging.getLogger(__name__)


@dataclass
class MoltbotConfig:
    url: str
    token: Optional[str]
    password: Optional[str]
    wait_timeout: float


class MoltbotGatewayManager:
    """Maintain a single long-lived GatewayWebSocketClient and reuse it for chats."""

    def __init__(self, cfg: MoltbotConfig):
        self._cfg = cfg
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

        self._client: Optional[GatewayWebSocketClient] = None
        self._waiters: Dict[str, asyncio.Future] = {}
        self._lock = threading.Lock()

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    async def _ensure_client(self) -> GatewayWebSocketClient:
        if self._client and not getattr(self._client, "_closed", False):
            return self._client

        logger.info("Connecting moltbot gateway %s", self._cfg.url)
        self._client = GatewayWebSocketClient(
            url=self._cfg.url,
            token=self._cfg.token,
            password=self._cfg.password,
            on_event=self._on_event,
            on_close=self._on_close,
        )
        await self._client.connect()
        return self._client

    def _on_close(self, code: int, reason: str) -> None:
        logger.warning("Moltbot gateway closed: %s %s", code, reason)
        self._client = None

    def _on_event(self, frame: Dict[str, Any]) -> None:
        if frame.get("event") != "chat":
            return
        payload = frame.get("payload") or {}
        run_id = payload.get("runId")
        state = payload.get("state")
        if not isinstance(run_id, str):
            return
        fut = self._waiters.get(run_id)
        if not fut:
            return
        if state in {"final", "error", "aborted"}:
            if not fut.done():
                fut.set_result(payload)

    async def _send_once(self, text: str, session_key: str) -> Dict[str, Any]:
        client = await self._ensure_client()
        run_id = str(uuid.uuid4())
        fut: asyncio.Future = self._loop.create_future()
        self._waiters[run_id] = fut

        try:
            await client.send_chat(
                session_key=session_key,
                message=text,
                idempotency_key=run_id,
            )
            payload: Dict[str, Any] = await asyncio.wait_for(fut, timeout=self._cfg.wait_timeout)  # type: ignore
            return payload
        except asyncio.TimeoutError:
            logger.warning("Moltbot wait timed out run_id=%s", run_id)
            return {}
        except GatewayError as exc:
            logger.error("Moltbot gateway error: %s", exc)
            self._client = None
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("Moltbot request failed: %s", exc, exc_info=True)
            self._client = None
            raise
        finally:
            self._waiters.pop(run_id, None)

    def send_chat(self, text: str, session_key: str) -> Dict[str, Any]:
        """Synchronous wrapper to send chat and wait for final payload."""
        cf = asyncio.run_coroutine_threadsafe(self._send_once(text, session_key), self._loop)
        return cf.result(timeout=self._cfg.wait_timeout + 5)
