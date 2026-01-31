from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import List

from .client import DEFAULT_TIMEOUT, NapcatRelayClient, send_group_forward_message, send_group_message, send_private_message
from .messages import FileMessage, ForwardNode, ImageMessage, ReplyMessage, TextMessage, VideoMessage
from .rpc import run_rpc_server


def _segment_action(segment_type: str):
    """Create an argparse action that appends (type, value) while preserving CLI order."""

    class _SegmentAction(argparse.Action):
        def __call__(self, parser, namespace, values, option_string=None):
            segments = getattr(namespace, self.dest, []) or []
            segments.append((segment_type, values))
            setattr(namespace, self.dest, segments)

    return _SegmentAction


def _load_dotenv_if_present() -> None:
    env_path = Path.cwd() / ".env"
    if not env_path.is_file():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("export "):
                stripped = stripped[len("export ") :].strip()
            if "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            os.environ[key] = value
    except OSError as exc:
        logging.debug("Skipping .env load: %s", exc)


def _configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "%(asctime)s [%(levelname)s] %(message)s"
    if verbose:
        # Verbose: keep stderr output for interactive debugging.
        logging.basicConfig(level=level, format=fmt, handlers=[logging.StreamHandler()], force=True)
        return

    # Non-verbose: write to nap-msg.log in the current working directory (avoid stdout/stderr).
    raw_path = os.getenv("NAP_MSG_LOG") or str(Path.cwd() / "nap-msg.log")
    log_path = Path(raw_path)
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(log_path, encoding="utf-8")
        logging.basicConfig(level=level, format=fmt, handlers=[handler], force=True)
        logging.getLogger(__name__).info("logging to %s", log_path)
    except OSError:
        # Fallback: if file handler fails, keep stderr logging (still avoids stdout).
        logging.basicConfig(level=level, format=fmt, handlers=[logging.StreamHandler()], force=True)
        logging.getLogger(__name__).warning("log file unavailable, fallback to stderr (path=%s)", log_path)


def _add_segment_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("-t", "--text", dest="segments", action=_segment_action("text"), help="Text segment")
    parser.add_argument("-i", "--image", dest="segments", action=_segment_action("image"), help="Image file path or URL")
    parser.add_argument("-f", "--file", dest="segments", action=_segment_action("file"), help="File path to upload")
    parser.add_argument("-v", "--video", dest="segments", action=_segment_action("video"), help="Video file path or URL")
    parser.add_argument("-r", "--reply", dest="segments", action=_segment_action("reply"), help="Reply to a message id")


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
    _add_segment_args(send_private)

    send_group = subparsers.add_parser("send-group", help="Send a group message")
    send_group.add_argument("group_id", help="Target QQ group id")
    _add_segment_args(send_group)
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

    rpc = subparsers.add_parser("rpc", help="Run JSON-RPC server on stdin/stdout")
    rpc.add_argument(
        "--napcat-url",
        dest="rpc_napcat_url",
        help="Napcat WebSocket endpoint (override global).",
    )
    rpc.add_argument(
        "--timeout",
        dest="rpc_timeout",
        type=float,
        default=None,
        help="Response wait timeout in seconds for RPC mode.",
    )

    return parser


def _build_message_segments(args: argparse.Namespace) -> List[object]:
    segments = getattr(args, "segments", []) or []
    parts: List[object] = []
    builders = {
        "reply": ReplyMessage,
        "text": TextMessage,
        "image": ImageMessage,
        "video": VideoMessage,
        "file": FileMessage,
    }
    for seg_type, value in segments:
        builder = builders.get(seg_type)
        if builder:
            parts.append(builder(value))
    return parts


def _build_forward_nodes(parts: List[object]) -> List[ForwardNode]:
    user_id = os.getenv("NAPCAT_FORWARD_USER_ID", "")
    nickname = os.getenv("NAPCAT_FORWARD_NICKNAME", "メイド")
    return [ForwardNode(user_id, nickname, [part]) for part in parts]


def _serialize_parts(parts: List[object]) -> List[dict]:
    return [part.as_dict() if hasattr(part, "as_dict") else part for part in parts]


def _print_response(response: dict) -> None:
    sys.stdout.write(json.dumps(response, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _message_parts_or_error(args: argparse.Namespace) -> List[object] | None:
    parts = _build_message_segments(args)
    if parts:
        return parts
    sys.stderr.write("No message content supplied; add --text/--image/--file/--video/--reply\n")
    return None


def _run_send_group(args: argparse.Namespace) -> int:
    parts = _message_parts_or_error(args)
    if not parts:
        return 2

    is_forward = args.forward or args.type == "forward"
    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    try:
        if is_forward:
            nodes = _build_forward_nodes(parts)
            response = asyncio.run(send_group_forward_message(client, args.group_id, nodes))
        else:
            response = asyncio.run(send_group_message(client, args.group_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


def _run_send_private(args: argparse.Namespace) -> int:
    parts = _message_parts_or_error(args)
    if not parts:
        return 2

    client = NapcatRelayClient(url=args.napcat_url, timeout=args.timeout)

    try:
        response = asyncio.run(send_private_message(client, args.user_id, _serialize_parts(parts)))
    except Exception as exc:  # noqa: BLE001
        logging.exception("Failed to send message: %s", exc)
        return 1

    _print_response(response)
    return 0


def main(argv: list[str] | None = None) -> int:
    _load_dotenv_if_present()
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)

    if args.command == "send":
        return _run_send_private(args)
    if args.command == "send-group":
        return _run_send_group(args)
    if args.command == "rpc":
        return run_rpc_server(
            default_url=getattr(args, "rpc_napcat_url", None) or args.napcat_url,
            default_timeout=getattr(args, "rpc_timeout", None) or args.timeout,
        )

    parser.error(f"Unknown command {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
