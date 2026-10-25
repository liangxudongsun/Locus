"""Offline SSH diagnostics regression tests; no servers or credentials required.

Run: python src-tauri/src/llm/claude_code_cli/ssh/diagnostics_test.py
"""
from contextlib import nullcontext
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
import uuid

if os.name == "nt":
    sys.modules.setdefault("pty", types.ModuleType("pty"))
host = types.ModuleType("locus_ssh_host_test")
source = Path(__file__).resolve().parents[1] / "ssh_host.py"
exec(compile(source.read_text(encoding="utf-8"), str(source), "exec"), host.__dict__)


class DiagnosticsTests(unittest.TestCase):
    def test_history_progress_precedes_lock_read_and_transfer(self):
        events = []

        def lease(root):
            self.assertEqual(events[-1]["stage"], "history_lock")
            return nullcontext()

        def history(config):
            self.assertEqual(events[-1]["stage"], "history_read")
            return {"version": 1}

        with patch.object(host, "frame", side_effect=lambda value, **kwargs: events.append(value)) as frame, \
                patch.object(host, "acquire_session_lease", side_effect=lease), \
                patch.object(host, "read_native_history", side_effect=history), \
                patch.object(host, "unlock_for_connection") as unlock, patch.object(host, "prepare") as prepare:
            host.run({"protocol": 1, "mode": "history", "sessionKey": str(uuid.uuid4()), "requireIdle": True})
        self.assertEqual(events[0]["source"], "helper")
        self.assertEqual([event.get("stage") for event in events[:-1]],
                         ["history", "history_lock", "history_read", "history_serialize"])
        self.assertEqual(events[-1]["type"], "hello")
        self.assertTrue(frame.call_args.kwargs["announce_history_size"])
        unlock.assert_not_called()
        prepare.assert_not_called()

    def test_announced_size_matches_unicode_json_and_final_newline(self):
        output = io.StringIO()
        value = {"type": "hello", "protocol": 1, "info": {"history": "中文\n"}}
        with patch.object(sys, "stdout", output):
            host.frame(value, announce_history_size=True)
        lines = output.getvalue().splitlines(keepends=True)
        progress, hello = map(json.loads, lines)
        self.assertEqual(progress["stage"], "history_transfer")
        self.assertEqual(progress["bytes"], len(lines[1].encode("utf-8")))
        self.assertEqual(hello, value)

    def test_normal_frames_add_no_progress_or_extra_serialization(self):
        output = io.StringIO()
        with patch.object(sys, "stdout", output), patch.object(json, "dumps", wraps=json.dumps) as dumps:
            host.frame({"type": "pong", "id": 1})
        self.assertEqual(dumps.call_count, 1)
        self.assertEqual(output.getvalue(), '{"type":"pong","id":1}\n')

    def test_failed_lease_does_not_report_history_read_or_ready(self):
        events = []
        with patch.object(host, "frame", side_effect=events.append), \
                patch.object(host, "acquire_session_lease", side_effect=TimeoutError("lease busy")), \
                patch.object(host, "read_native_history") as history:
            with self.assertRaisesRegex(TimeoutError, "lease busy"):
                host.run({"protocol": 1, "mode": "history", "sessionKey": str(uuid.uuid4()), "requireIdle": True})
        history.assert_not_called()
        self.assertEqual(events[-1]["stage"], "history_lock")


if __name__ == "__main__":
    unittest.main()
