from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

import websockets

from .client import NapcatRelayClient, send_group_message, send_private_message
from .messages import TextMessage
from .moltbot_client import MoltbotConfig, MoltbotGatewayManager

logger = logging.getLogger(__name__)


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
    moltbot_mgr: MoltbotGatewayManager,
    allow_senders: set[str],
    fire_and_forget: bool,
    ignore_prefixes: list[str],
) -> None:
    message_type = event.get("message_type")
    if message_type not in {"group", "private"}:
        return

    sender = str(event.get("user_id", "")) if "user_id" in event else ""
    if allow_senders and sender not in allow_senders:
        return

    text = _extract_text(event)
    if not text:
        logger.debug("No text content in event, skip")
        return
    first_line = next((ln for ln in text.splitlines() if ln.strip()), text)
    check_text = first_line.lstrip()
    for prefix in ignore_prefixes:
        if check_text.startswith(prefix):
            return

    logger.info(
        "Forwarding to moltbot: session=%s chars=%d preview=%r",
        _build_session_key(event),
        len(text),
        text[:200],
    )
    session_key = _build_session_key(event)
    try:
        response = moltbot_mgr.send_chat(text=text, session_key=session_key)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to send to moltbot: %s", exc)
        return

    logger.debug("Moltbot raw response: %r", response)
    reply_text = _extract_reply_text(response)
    logger.info(
        "Moltbot response: text_present=%s stitched=%s",
        bool(reply_text),
        bool(response.get("events")) if isinstance(response, dict) else False,
    )
    if fire_and_forget:
        return
    if not reply_text:
        return

    segment = TextMessage(reply_text).as_dict()
    try:
        if message_type == "group":
            await send_group_message(napcat_client, str(event.get("group_id", "")), [segment])
        else:
            await send_private_message(napcat_client, str(event.get("user_id", "")), [segment])
        logger.info(
            "Sent reply via Napcat: type=%s target=%s chars=%d preview=%r",
            message_type,
            event.get("group_id") if message_type == "group" else event.get("user_id"),
            len(reply_text),
            reply_text[:200],
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to send reply via Napcat: %s", exc)


def _extract_reply_text(response: Dict[str, Any]) -> Optional[str]:
    if not isinstance(response, dict):
        return None
    final = response.get("final_text") or response.get("text")
    if isinstance(final, str) and final.strip():
        return _strip_tool_marker(final.strip())

    # From message.content list
    message = response.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if not isinstance(item, dict):
                    continue
                txt = item.get("text")
                if isinstance(txt, str):
                    parts.append(txt)
            stitched_msg = "".join(parts).strip()
            if stitched_msg:
                return _strip_tool_marker(stitched_msg)

    # Fallback: stitch assistant stream texts from events
    events = response.get("events")
    if isinstance(events, list):
        parts: list[str] = []
        for ev in events:
            if not isinstance(ev, dict):
                continue
            stream = ev.get("stream")
            if stream and stream != "assistant":
                continue
            txt = ev.get("text")
            if isinstance(txt, str):
                parts.append(txt)
        stitched = "".join(parts).strip()
        return _strip_tool_marker(stitched) or None
    return None


def _strip_tool_marker(text: str) -> str:
    """Remove trailing tool-call markers like [[reply_to_current ..."""
    marker_pos = text.find("[[")
    if marker_pos != -1:
        return text[:marker_pos].rstrip()
    return text


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


async def watch_napcat_events(
    event_url: str,
    napcat_client: NapcatRelayClient,
    moltbot_mgr: MoltbotGatewayManager,
    fire_and_forget: bool,
    ignore_prefixes: list[str],
) -> None:
    allow_senders = _load_allow_senders()
    if allow_senders:
        logger.info("Allow list enabled: %s", ", ".join(sorted(allow_senders)))
    if ignore_prefixes:
        logger.info("Ignore prefixes: %s", ", ".join(ignore_prefixes))

    while True:
        try:
            logger.info("Connecting to Napcat event stream %s", event_url)
            async with websockets.connect(event_url, max_size=None) as ws:
                async for raw in ws:
                    logger.debug("WS raw frame: %s", raw)
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
                        await handle_message_event(
                            event,
                            napcat_client,
                            moltbot_mgr,
                            allow_senders,
                            fire_and_forget,
                            ignore_prefixes,
                        )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("Napcat event stream error: %s, retrying in 3s", exc)
            await asyncio.sleep(3)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Napcat -> moltbot relay daemon")
    parser.add_argument("--fire-and-forget", action="store_true", help="Send to moltbot but do not send replies back to QQ")
    parser.add_argument(
        "--ignore-startswith",
        action="append",
        default=[],
        help="If provided, skip relaying messages that start with any of these prefixes.",
    )
    args = parser.parse_args(argv)

    ignore_prefixes = [p for p in (args.ignore_startswith or []) if isinstance(p, str) and p]

    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    logger.info(
        "Daemon config: fire_and_forget=%s ignore_prefixes=%s",
        args.fire_and_forget,
        ignore_prefixes or "[]",
    )
    napcat_url = os.getenv("NAPCAT_URL")
    if not napcat_url:
        raise SystemExit("NAPCAT_URL is required")
    napcat_client = NapcatRelayClient(url=napcat_url)
    moltbot_cfg = load_moltbot_config()
    moltbot_mgr = MoltbotGatewayManager(moltbot_cfg)

    try:
        asyncio.run(
            watch_napcat_events(
                napcat_url,
                napcat_client,
                moltbot_mgr,
                args.fire_and_forget,
                ignore_prefixes,
            )
        )
    except KeyboardInterrupt:
        logger.info("Shutting down daemon")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
