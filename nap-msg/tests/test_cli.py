import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from nap_msg.cli import main


class CliTest(unittest.TestCase):
    def test_video_send_returns_queued_without_waiting(self):
        output = io.StringIO()
        with (
            patch("nap_msg.cli._configure_logging"),
            patch("nap_msg.cli.subprocess.Popen") as popen,
            redirect_stdout(output),
        ):
            result = main(["send-group", "123", "--video-url", "https://example.com/v"])

        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "queued")
        command = popen.call_args.args[0]
        self.assertEqual(command[:4], [sys.executable, "-m", "nap_msg.cli", "--background-worker"])
        self.assertTrue(popen.call_args.kwargs["start_new_session"])


if __name__ == "__main__":
    unittest.main()
