from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

import websockets
from moltbot import chat_once_async

from .client import NapcatRelayClient, send_group_message, send_private_message
from .messages import TextMessage

logger = logging.getLogger(__name__)


@dataclass
class MoltbotConfig:
    url: str
    token: Optional[str]
    password: Optional[str]
    wait_timeout: float


def _load_allow_senders() -> set[str]:
    raw = os.getenv("ALLOW_SENDERS", "")
    parts = [p.strip() for p in raw.replace(",", " ").split() if p.strip()]
    return set(parts)


def load_moltbot_config() -> MoltbotConfig:
    url = os.getenv("MOLTBOT_URL", "ws://127.0.0.1:18789")
    token = os.getenv("MOLTBOT_TOKEN")
    password = os.getenv("MOLTBOT_PASSWORD")
    wait_timeout = float(os.getenv("MOLTBOT_WAIT_TIMEOUT", "60"))
    return MoltbotConfig(url=url, token=token, password=password, wait_timeout=wait_timeout)


async def handle_message_event(
    event: Dict[str, Any],
    napcat_client: NapcatRelayClient,
    moltbot_cfg: MoltbotConfig,
    allow_senders: set[str],
) -> None:
    message_type = event.get("message_type")
    if message_type not in {"group", "private"}:
        return

    sender = str(event.get("user_id", "")) if "user_id" in event else ""
    if allow_senders and sender not in allow_senders:
        logger.info("Ignore message from disallowed sender=%s", sender)
        return

    text = _extract_text(event)
    if not text:
        logger.debug("No text content in event, skip")
        return

    session_key = _build_session_key(event)
    try:
        response = await chat_once_async(
            url=moltbot_cfg.url,
            token=moltbot_cfg.token,
            password=moltbot_cfg.password,
            session_key=session_key,
            message=text,
            wait_timeout=moltbot_cfg.wait_timeout,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to send to moltbot: %s", exc)
        return

    reply_text = _extract_reply_text(response)
    if not reply_text:
        logger.debug("No reply text from moltbot, skip")
        return

    segment = TextMessage(reply_text).as_dict()
    try:
        if message_type == "group":
            await send_group_message(napcat_client, str(event.get("group_id", "")), [segment])
        else:
            await send_private_message(napcat_client, str(event.get("user_id", "")), [segment])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to send reply via Napcat: %s", exc)


def _extract_reply_text(response: Dict[str, Any]) -> Optional[str]:
    if not isinstance(response, dict):
        return None
    final = response.get("final_text") or response.get("text")
    if isinstance(final, str):
        return final.strip()
    return None


def _extract_text(event: Dict[str, Any]) -> Optional[str]:
    message = event.get("message")
    if isinstance(message, str):
        return message
    if not isinstance(message, list):
        return None
    parts = []
    for item in message:
        if isinstance(item, dict) and item.get("type") == "text":
            data = item.get("data") or {}
            if isinstance(data, dict):
                value = data.get("text")
                if isinstance(value, str):
                    parts.append(value)
    return "\n".join(parts) if parts else None


def _build_session_key(event: Dict[str, Any]) -> str:
    if event.get("message_type") == "group":
        gid = event.get("group_id", "")
        return f"qq-group-{gid}"
    uid = event.get("user_id", "")
    return f"qq-user-{uid}"


async def watch_napcat_events(event_url: str, napcat_client: NapcatRelayClient, moltbot_cfg: MoltbotConfig) -> None:
    allow_senders = _load_allow_senders()
    if allow_senders:
        logger.info("Allow list enabled: %s", ", ".join(sorted(allow_senders)))

    while True:
        try:
            logger.info("Connecting to Napcat event stream %s", event_url)
            async with websockets.connect(event_url, max_size=None) as ws:
                async for raw in ws:
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        logger.warning("Discarding non-JSON event: %s", raw)
                        continue
                    if not isinstance(event, dict):
                        continue
                    message_type = event.get("message_type")
                    if message_type in {"group", "private"}:
                        preview = _extract_text(event) or ""
                        logger.info(
                            "Incoming QQ message: type=%s group=%s user=%s text=%r",
                            message_type,
                            event.get("group_id"),
                            event.get("user_id"),
                            preview[:200],
                        )
                        await handle_message_event(event, napcat_client, moltbot_cfg, allow_senders)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("Napcat event stream error: %s, retrying in 3s", exc)
            await asyncio.sleep(3)


def main(argv: Optional[list[str]] = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    napcat_url = os.getenv("NAPCAT_URL")
    if not napcat_url:
        raise SystemExit("NAPCAT_URL is required")
    napcat_client = NapcatRelayClient(url=napcat_url)
    moltbot_cfg = load_moltbot_config()

    try:
        asyncio.run(watch_napcat_events(napcat_url, napcat_client, moltbot_cfg))
    except KeyboardInterrupt:
        logger.info("Shutting down daemon")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
