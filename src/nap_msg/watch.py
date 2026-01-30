from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import sys
import uuid
from typing import Optional
from urllib.parse import urlparse

import websockets

from .asr import sentence_recognize

KEEP_FIELDS = {
    "user_id",
    "group_id",
    "message_type",
    "message_id",
    "raw_message",
    # "time",
    # "target_id",
}

DEFAULT_IGNORE_PREFIXES = ["/"]
PASSTHROUGH_COMMANDS = {"/new", "/reset"}
CQ_CODE_PATTERN = re.compile(r"\[CQ:(face|image)[^\]]*\]", re.IGNORECASE)


def run_watch(args) -> int:
    url = os.getenv("NAPCAT_URL")
    if not url:
        sys.stderr.write("NAPCAT_URL is required for watch\n")
        return 2

    ignore_prefixes = args.ignore_startswith or DEFAULT_IGNORE_PREFIXES
    asr_enabled = bool(os.getenv("TENCENT_SECRET_ID", "").strip() and os.getenv("TENCENT_SECRET_KEY", "").strip())

    if not args.verbose:
        logging.getLogger().setLevel(logging.ERROR)
    try:
        asyncio.run(
            watch_forever(
                url=url,
                from_group=args.from_group,
                from_user=args.from_user,
                ignore_prefixes=ignore_prefixes,
                asr_enabled=asr_enabled,
                emit=_emit_rpc_notification,
            )
        )
    except KeyboardInterrupt:
        if args.verbose:
            logging.info("watch stopped by user")
    return 0


async def watch_forever(
    url: str,
    from_group: Optional[str],
    from_user: Optional[str],
    ignore_prefixes: list[str],
    asr_enabled: bool,
    emit,
) -> None:
    while True:
        try:
            logging.info("Connecting to Napcat event stream %s", url)
            async with websockets.connect(url, max_size=None) as ws:
                while True:
                    raw = await ws.recv()
                    logging.debug("WS raw frame: %s", raw)
                    event = _try_parse_json(raw)
                    if not event:
                        continue
                    if event.get("post_type") != "message":
                        continue
                    if from_group and str(event.get("group_id")) != str(from_group):
                        continue
                    if from_user and str(event.get("user_id")) != str(from_user):
                        continue

                    text_content, record_file = _extract_text_and_record(event)
                    if text_content:
                        cleaned = _strip_cq_and_whitespace(text_content)
                        if not cleaned:
                            continue
                        text_content = cleaned
                        first_line = next((ln for ln in text_content.splitlines() if ln.strip()), text_content)
                        check_text = first_line.lstrip()
                        passthrough_command = _is_passthrough_command(check_text)
                        if ignore_prefixes and not passthrough_command and any(
                            check_text.startswith(pfx) for pfx in ignore_prefixes
                        ):
                            continue
                    elif not record_file:
                        continue

                    resolved = await _resolve_text(text_content, record_file, ws, url, asr_enabled)
                    if resolved:
                        event["raw_message"] = resolved
                    elif not text_content:
                        continue
                    filtered = {k: v for k, v in event.items() if k in KEEP_FIELDS and v is not None}
                    try:
                        maybe_coro = emit(filtered)
                        if asyncio.iscoroutine(maybe_coro):
                            await maybe_coro
                    except Exception as emit_exc:  # noqa: BLE001
                        logging.warning("Failed to emit event: %s", emit_exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logging.warning("Watch loop error %s, reconnecting in 3s", exc)
            await asyncio.sleep(3)


def _try_parse_json(raw: str) -> Optional[dict]:
    try:
        return json.loads(raw)
    except Exception:
        logging.debug("Failed to decode websocket frame as JSON")
        return None


def _emit_rpc_notification(event: dict) -> None:
    payload = {"jsonrpc": "2.0", "method": "message.receive", "params": _event_to_receive_params(event)}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _event_to_receive_params(event: dict) -> dict:
    message_type = str(event.get("message_type") or "").lower()
    is_group = message_type == "group"
    chat_id = event.get("group_id") if is_group else event.get("user_id")
    return {
        "sender": event.get("user_id"),
        "chatId": chat_id,
        "isGroup": is_group,
        "text": event.get("raw_message"),
        "messageId": event.get("message_id"),
    }


def _extract_text_and_record(event: dict) -> tuple[Optional[str], Optional[str]]:
    message = event.get("message")
    if isinstance(message, str):
        return message, None
    if not isinstance(message, list):
        return None, None
    text_parts = []
    record_file = None
    for item in message:
        if not isinstance(item, dict):
            continue
        seg_type = item.get("type", "")
        seg_data = item.get("data", {}) or {}
        if seg_type == "at":
            continue
        if seg_type == "text":
            txt = seg_data.get("text")
            if isinstance(txt, str):
                text_parts.append(txt)
        elif seg_type == "record" and record_file is None:
            rec_path = seg_data.get("file")
            if isinstance(rec_path, str) and rec_path.strip():
                record_file = rec_path.strip()
        elif seg_type in {"face", "image"}:
            continue
    return ("\n".join(text_parts) if text_parts else None, record_file)


async def _resolve_text(
    clean_text: Optional[str], record_file: Optional[str], ws, napcat_ws: str, allow_asr: bool
) -> Optional[str]:
    """Normalize text, falling back to voice transcription when needed."""
    if clean_text:
        return clean_text
    if not record_file or not allow_asr:
        return None

    try:
        audio_bytes = await _fetch_voice(record_file, ws, napcat_ws)
        if not audio_bytes:
            return None
        text = await sentence_recognize(audio_bytes, voice_format="mp3")
        return text
    except Exception as exc:  # noqa: BLE001
        logging.debug("ASR failed, skip message: %s", exc)
        return None


async def _fetch_voice(path: str, ws, napcat_ws: str) -> bytes:
    if not napcat_ws:
        return b""
    parsed = urlparse(napcat_ws)
    if parsed.scheme not in ("ws", "wss"):
        return b""

    payload = {"file": path, "out_format": "mp3"}
    echo = str(uuid.uuid4())
    request_body = {"action": "get_record", "params": payload, "echo": echo}

    try:
        await ws.send(json.dumps(request_body))
    except Exception:
        return b""

    response = None
    for _ in range(10):
        try:
            response_raw = await asyncio.wait_for(ws.recv(), timeout=10)
        except Exception:
            break
        candidate = _try_parse_json(response_raw)
        if not candidate:
            continue
        if candidate.get("post_type") == "meta_event":
            continue
        if candidate.get("echo") and candidate.get("echo") != echo:
            continue
        if not candidate.get("status"):
            continue
        response = candidate
        break

    if response is None:
        return b""

    data = response.get("data") or {}
    status = response.get("status")
    if status != "ok":
        logging.debug("Napcat get_record full response: %s", response)
        return b""
    record_base64 = data.get("base64") if isinstance(data, dict) else None

    if record_base64:
        try:
            return base64.b64decode(record_base64)
        except Exception:
            return b""

    # No base64 available
    return b""


def _strip_cq_and_whitespace(text: str) -> str:
    text = CQ_CODE_PATTERN.sub("", text)
    text = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return text.strip()


def _is_passthrough_command(text: str) -> bool:
    return text.strip() in PASSTHROUGH_COMMANDS
