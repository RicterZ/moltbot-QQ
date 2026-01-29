from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import List, Optional

import httpx
from .client import DEFAULT_TIMEOUT, NapcatRelayClient, send_group_forward_message, send_group_message, send_private_message
from .messages import FileMessage, ForwardNode, ImageMessage, ReplyMessage, TextMessage, VideoMessage
import websockets
from .asr import sentence_recognize


def _segment_action(segment_type: str):
    """
    Factory to create an argparse action that appends (order, type, value) tuples,
    preserving the order segments appear on the command line.
    """

    class _SegmentAction(argparse.Action):
        _counter = 0

        def __call__(self, parser, namespace, values, option_string=None):
            segments = getattr(namespace, self.dest, None)
            if segments is None:
                segments = []
            segments.append((_SegmentAction._counter, segment_type, values))
            _SegmentAction._counter += 1
            setattr(namespace, self.dest, segments)

    return _SegmentAction


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s [%(levelname)s] %(message)s")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nap-msg",
        description="Relay CLI for sending messages from moltbot to Napcat.",
    )
    parser.add_argument(
        "--napcat-url",
        default=os.getenv("NAPCAT_URL"),
        help="Napcat WebSocket endpoint (env NAPCAT_URL).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        help=f"Response wait timeout in seconds (default: env NAPCAT_TIMEOUT or {DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    send_private = subparsers.add_parser("send", help="Send a private message")
    send_private.add_argument("user_id", help="Target QQ user id")
    send_private.add_argument("-t", "--text", dest="segments", action=_segment_action("text"), help="Text segment")
    send_private.add_argument("-i", "--image", dest="segments", action=_segment_action("image"), help="Image file path or URL")
    send_private.add_argument("-f", "--file", dest="segments", action=_segment_action("file"), help="File path to upload")
    send_private.add_argument("-v", "--video", dest="segments", action=_segment_action("video"), help="Video file path or URL")
    send_private.add_argument("-r", "--reply", dest="segments", action=_segment_action("reply"), help="Reply to a message id")

    send_group = subparsers.add_parser("send-group", help="Send a group message")
    send_group.add_argument("group_id", help="Target QQ group id")
    send_group.add_argument("-t", "--text", dest="segments", action=_segment_action("text"), help="Text segment")
    send_group.add_argument("-i", "--image", dest="segments", action=_segment_action("image"), help="Image file path or URL")
    send_group.add_argument("-f", "--file", dest="segments", action=_segment_action("file"), help="File path to upload")
    send_group.add_argument("-v", "--video", dest="segments", action=_segment_action("video"), help="Video file path or URL")
    send_group.add_argument("-r", "--reply", dest="segments", action=_segment_action("reply"), help="Reply to a message id")
    send_group.add_argument(
        "--type",
        choices=["normal", "forward"],
        default="normal",
        help="Send as normal message or as a forward message.",
    )
    send_group.add_argument(
        "--forward",
        action="store_true",
        help="Shortcut for --type forward.",
    )

    watch = subparsers.add_parser("watch", help="Watch QQ incoming messages and print JSON")
    watch.add_argument("--from-group", dest="from_group", help="Only include messages from this group id")
    watch.add_argument("--from-user", dest="from_user", help="Only include messages from this user id")
    watch.add_argument(
        "--ignore-startswith",
        action="append",
        default=[],
        help="Skip messages whose text starts with any of these prefixes.",
    )

    return parser


def _build_message_segments(args: argparse.Namespace) -> List[object]:
    segments = getattr(args, "segments", []) or []
    ordered = sorted(segments, key=lambda x: x[0])
    parts: List[object] = []
    for _, seg_type, value in ordered:
        if seg_type == "reply":
            parts.append(ReplyMessage(value))
        elif seg_type == "text":
            parts.append(TextMessage(value))
        elif seg_type == "image":
            parts.append(ImageMessage(value))
        elif seg_type == "video":
            parts.append(VideoMessage(value))
        elif seg_type == "file":
            parts.append(FileMessage(value))
    return parts


def _build_forward_nodes(args: argparse.Namespace, parts: List[object]) -> List[ForwardNode]:
    user_id = os.getenv("NAPCAT_FORWARD_USER_ID", "")
    nickname = os.getenv("NAPCAT_FORWARD_NICKNAME", "メイド")
    return [ForwardNode(user_id, nickname, [part]) for part in parts]


def _serialize_parts(parts: List[object]) -> List[dict]:
    return [part.as_dict() if hasattr(part, "as_dict") else part for part in parts]


def _print_response(response: dict) -> None:
    sys.stdout.write(json.dumps(response, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _run_send_group(args: argparse.Namespace) -> int:
    parts = _build_message_segments(args)
    if not parts:
        sys.stderr.write("No message content supplied; add --text/--image/--file/--video/--reply\n")
        return 2

    is_forward = args.forward or args.type == "forward"
    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    try:
        if is_forward:
            nodes = _build_forward_nodes(args, parts)
            response = asyncio.run(send_group_forward_message(client, args.group_id, nodes))
        else:
            response = asyncio.run(send_group_message(client, args.group_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


def _run_send_private(args: argparse.Namespace) -> int:
    parts = _build_message_segments(args)
    if not parts:
        sys.stderr.write("No message content supplied; add --text/--image/--file/--video/--reply\n")
        return 2

    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    try:
        response = asyncio.run(send_private_message(client, args.user_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


KEEP_FIELDS = {
    "user_id",
    "group_id",
    "message_type",
    "message_id",
    "raw_message",
    "message",
    "resolved_text",
    "post_type",
    "time",
    "target_id",
}

DEFAULT_IGNORE_PREFIXES = ["/", "[CQ:"]


async def _watch_loop(url: str, from_group: Optional[str], from_user: Optional[str], ignore_prefixes: list[str]) -> None:
    while True:
        try:
            logging.info("Connecting to Napcat event stream %s", url)
            async with websockets.connect(url, max_size=None) as ws:
                async for raw in ws:
                    logging.debug("WS raw frame: %s", raw)
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        logging.warning("Discard non-JSON frame")
                        continue
                    if not isinstance(event, dict):
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
                    if ignore_prefixes and text_content:
                        first_line = next((ln for ln in text_content.splitlines() if ln.strip()), text_content)
                        check_text = first_line.lstrip()
                        if any(check_text.startswith(pfx) for pfx in ignore_prefixes):
                            continue
                    resolved = await _resolve_text(text_content, record_file)
                    if resolved:
                        event["resolved_text"] = resolved
                    filtered = {k: v for k, v in event.items() if k in KEEP_FIELDS}
                    sys.stdout.write(json.dumps(filtered, ensure_ascii=False))
                    sys.stdout.write("\n")
                    sys.stdout.flush()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logging.warning("Watch loop error %s, reconnecting in 3s", exc)
            await asyncio.sleep(3)


def _run_watch(args: argparse.Namespace) -> int:
    url = os.getenv("NAPCAT_URL")
    if not url:
        sys.stderr.write("NAPCAT_URL is required for watch\n")
        return 2
    ignore_prefixes = args.ignore_startswith or []
    if not ignore_prefixes:
        ignore_prefixes = DEFAULT_IGNORE_PREFIXES
    # Silence logging for clean JSON output unless verbose was explicitly requested
    if not args.verbose:
        logging.getLogger().setLevel(logging.ERROR)
    try:
        asyncio.run(_watch_loop(url, args.from_group, args.from_user, ignore_prefixes))
    except KeyboardInterrupt:
        if args.verbose:
            logging.info("watch stopped by user")
    return 0


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
            rec = seg_data.get("file")
            if isinstance(rec, str):
                record_file = rec
    return ("\n".join(text_parts) if text_parts else None, record_file)


async def _resolve_text(clean_text: Optional[str], record_file: Optional[str]) -> Optional[str]:
    """Normalize text, falling back to voice transcription when needed."""
    if clean_text:
        return clean_text
    if not record_file:
        return None

    secret_id = os.getenv("TENCENT_SECRET_ID", "").strip()
    secret_key = os.getenv("TENCENT_SECRET_KEY", "").strip()
    if not secret_id or not secret_key:
        logging.info("Voice message ignored (missing Tencent ASR credentials)")
        return None

    try:
        audio_bytes = await _fetch_voice(record_file)
        text = await sentence_recognize(audio_bytes, voice_format="mp3")
        logging.info("ASR transcribed voice to text: %s", text)
        return text
    except Exception as exc:  # noqa: BLE001
        logging.warning("ASR failed, skip replying: %s", exc)
        return None


async def _fetch_voice(path: str) -> bytes:
    if path.startswith("http://") or path.startswith("https://"):
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(path)
            resp.raise_for_status()
            return resp.content
    # treat as local path
    async with asyncio.Semaphore(1):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _read_file_bytes, path)


def _read_file_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _strip_cq_and_whitespace(text: str) -> str:
    import re

    # Remove CQ codes like [CQ:face,id=67] or [CQ:image,...]
    text = re.sub(r"\[CQ:[^\]]+\]", "", text)
    # Normalize whitespace
    text = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return text.strip()


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)

    if args.command == "send":
        return _run_send_private(args)
    if args.command == "send-group":
        return _run_send_group(args)
    if args.command == "watch":
        return _run_watch(args)

    parser.error(f"Unknown command {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
