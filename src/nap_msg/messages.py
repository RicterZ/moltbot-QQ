from __future__ import annotations

import base64
import uuid
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional


def _as_file_uri(file_path: str) -> str:
    """
    Convert local file to base64://... or pass through remote/base64 URIs.
    """
    if file_path.startswith("base64://") or file_path.startswith(("http://", "https://")):
        return file_path
    data = Path(file_path).expanduser().resolve().read_bytes()
    encoded = base64.b64encode(data).decode("ascii")
    return f"base64://{encoded}"


class CommandType(str, Enum):
    SEND_GROUP_MSG = "send_group_msg"
    SEND_GROUP_FORWARD_MSG = "send_group_forward_msg"
    SEND_PRIVATE_MSG = "send_private_msg"


class Command:
    def __init__(self, action: CommandType, params: Dict[str, Any], echo: Optional[str] = None):
        self.action = action
        self.params = params
        self.echo = echo or str(uuid.uuid4())

    def as_dict(self) -> Dict[str, Any]:
        return {"action": self.action.value, "params": self.params, "echo": self.echo}

    def __repr__(self) -> str:
        return f"Command<action={self.action.value}, params={self.params}>"


class TextMessage:
    def __init__(self, content: str):
        self.data = {"text": content}

    def as_dict(self) -> Dict[str, Any]:
        return {"type": "text", "data": self.data}


class ReplyMessage:
    def __init__(self, message_id: str):
        self.data = {"id": str(message_id)}

    def as_dict(self) -> Dict[str, Any]:
        return {"type": "reply", "data": self.data}


class FileMessage:
    def __init__(self, file_path: str, name: Optional[str] = None):
        self.data = {"file": _as_file_uri(file_path)}
        if name:
            self.data["name"] = name

    def as_dict(self) -> Dict[str, Any]:
        return {"type": "file", "data": self.data}


class ImageMessage:
    def __init__(self, file_path: str):
        self.data = {"file": _as_file_uri(file_path)}

    def as_dict(self) -> Dict[str, Any]:
        return {"type": "image", "data": self.data}


class VideoMessage:
    def __init__(self, file_path: str):
        self.data = {"file": _as_file_uri(file_path)}

    def as_dict(self) -> Dict[str, Any]:
        return {"type": "video", "data": self.data}


class ForwardNode:
    def __init__(self, user_id: str | int, nickname: str, content: List[Any]):
        self.data = {
            "user_id": user_id,
            "nickname": nickname,
            "content": [msg.as_dict() if hasattr(msg, "as_dict") else msg for msg in content],
        }

    def as_dict(self) -> Dict[str, Any]:
        return {"type": "node", "data": self.data}
