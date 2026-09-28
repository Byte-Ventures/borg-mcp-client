"""Unit tests for the borg-representative-push Hermes plugin (v2, listener protocol 2).

Hermes is not imported: `ctx` is a fake that records registrations and injections,
and `borg` is a fake protocol-2 listener script that follows a scripted run: it
prints events, reads acks from its stdin, waits for EOF, and exits with a
scripted code. Run with: python3 -m unittest discover -s hermes-plugin/tests
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "borg-representative-push"
_spec = importlib.util.spec_from_file_location("borg_representative_push", PLUGIN_DIR / "__init__.py")
push = importlib.util.module_from_spec(_spec)
sys.modules["borg_representative_push"] = push
_spec.loader.exec_module(push)

SESSION_KEY = "agent:main:telegram:dm:4242"
WAKE1 = "11111111-1111-4111-8111-111111111111"
WAKE2 = "22222222-2222-4222-8222-222222222222"
LISTENING = {"event": "listening", "protocol": 2, "binding_fingerprint": "f" * 64, "undelivered": 0}


def wake(wake_id: str, reason: str = "new-reply", count: int = 1) -> dict:
    return {"event": "wake", "wake_id": wake_id, "reason": reason, "count": count}


def wait_until(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class FakeCtx:
    def __init__(self, settings: dict):
        self.settings = settings
        self.platform_handlers: list[tuple[str, object]] = []
        self.hooks: list[tuple[str, object]] = []
        self.injected: list[tuple[str, str, str]] = []
        self.accept = True

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_platform_handler(self, platform, factory):
        self.platform_handlers.append((platform, factory))

    def register_hook(self, name, callback):
        self.hooks.append((name, callback))

    def inject_message(self, content, role="user", *, session_key=None):
        self.injected.append((content, role, session_key))
        return self.accept


class FakeListener:
    """An executable `borg` stand-in speaking protocol 2. Run i uses runs[min(i, last)].

    A run is a list of steps: {"emit": event}, {"ack": true} (read one stdin line
    and record it), {"eof": true} (read stdin until EOF), {"stderr": text},
    {"sleep": seconds}, {"ignore_term": true} (ignore SIGTERM), and a final {"exit": code}.
    """

    def __init__(self, root: Path, runs: list[list[dict]]):
        self.root = root
        self.spec = root / "spec.json"
        self.calls = root / "calls.jsonl"
        self.acks_path = root / "acks.jsonl"
        self.events_path = root / "events.jsonl"
        self.spec.write_text(json.dumps({"runs": runs, "calls": str(self.calls), "acks": str(self.acks_path),
                                         "events": str(self.events_path)}))
        self.path = root / "fake-borg"
        self.path.write_text(textwrap.dedent(f"""\
            #!{sys.executable}
            import json, os, signal, stat, sys, time
            spec = json.load(open({str(self.spec)!r}))
            try:
                count = sum(1 for _ in open(spec["calls"]))
            except OSError:
                count = 0
            mode = os.fstat(0).st_mode
            with open(spec["calls"], "a") as handle:
                handle.write(json.dumps({{"argv": sys.argv[1:], "stdin_pipe": stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)}}) + "\\n")
            run = spec["runs"][min(count, len(spec["runs"]) - 1)]
            def record(name, value):
                with open(spec[name], "a") as handle:
                    handle.write(json.dumps(value) + "\\n")
            for step in run:
                if "emit" in step:
                    print(json.dumps(step["emit"]) if isinstance(step["emit"], dict) else step["emit"], flush=True)
                elif "ack" in step:
                    line = sys.stdin.readline()
                    record("acks", json.loads(line) if line.strip() else None)
                elif "eof" in step:
                    rest = sys.stdin.read()
                    record("events", {{"eof": True, "rest": rest}})
                elif "stderr" in step:
                    print(step["stderr"], file=sys.stderr, flush=True)
                elif "sleep" in step:
                    time.sleep(step["sleep"])
                elif "ignore_term" in step:
                    signal.signal(signal.SIGTERM, signal.SIG_IGN)
                elif "exit" in step:
                    sys.exit(step["exit"])
            sys.exit(0)
            """))
        self.path.chmod(0o755)

    def _lines(self, path: Path) -> list:
        try:
            return [json.loads(line) for line in path.read_text().splitlines()]
        except OSError:
            return []

    def invocations(self) -> list[dict]:
        return self._lines(self.calls)

    def acks(self) -> list:
        return self._lines(self.acks_path)

    def eofs(self) -> list:
        return self._lines(self.events_path)


def settings(**overrides) -> dict:
    base = {"session_key": SESSION_KEY, "worktree": "/srv/rep-worktree"}
    base.update(overrides)
    return base


class Case(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.supervisors: list = []
        push._SUPERVISOR = None

    def tearDown(self):
        for supervisor in self.supervisors:
            supervisor.shutdown(timeout=2)
        if push._SUPERVISOR is not None:
            push._SUPERVISOR.shutdown(timeout=2)
            push._SUPERVISOR = None
        self._tmp.cleanup()

    def supervisor(self, fake: FakeListener, accept=True, **kwargs):
        loaded, problem = push.load_settings(FakeCtx(settings(borg_command=str(fake.path))).get_config)
        self.assertIsNone(problem)
        self.injected: list[str] = []

        def sink(text: str) -> bool:
            self.injected.append(text)
            if isinstance(accept, BaseException):
                raise accept
            return accept

        options = {"backoff_start_s": 0.05, "backoff_cap_s": 0.2}
        options.update(kwargs)
        supervisor = push.Supervisor(loaded, sink, **options)
        self.supervisors.append(supervisor)
        return supervisor


class SettingsTests(unittest.TestCase):
    def test_valid_settings_and_defaults(self):
        loaded, problem = push.load_settings(FakeCtx(settings()).get_config)
        self.assertIsNone(problem)
        self.assertEqual(loaded, push.Settings(SESSION_KEY, "telegram", "/srv/rep-worktree", "borg"))

    def test_only_three_settings_exist(self):
        self.assertEqual(push.Settings._fields, ("session_key", "platform", "worktree", "borg_command"))
        yaml = (PLUGIN_DIR / "plugin.yaml").read_text()
        for removed in ("mcp_server", "reinject_after_s", "max_reinjects"):
            self.assertNotIn(removed, yaml)
        # Old keys left in a 5.x config are ignored, not refused.
        loaded, problem = push.load_settings(FakeCtx(settings(mcp_server="x", reinject_after_s=0, max_reinjects=-1)).get_config)
        self.assertIsNone(problem)
        self.assertIsNotNone(loaded)

    def test_invalid_settings_are_rejected_with_a_reason(self):
        for override in [{"session_key": None}, {"session_key": "telegram:dm:1"}, {"session_key": "agent:main:Tele gram:dm"},
                         {"session_key": "agent:main:telegram"}, {"worktree": "relative/path"}, {"borg_command": ""},
                         {"borg_command": "borg\n--evil"}]:
            with self.subTest(override=override):
                loaded, problem = push.load_settings(FakeCtx(settings(**override)).get_config)
                self.assertIsNone(loaded)
                self.assertTrue(problem)

    def test_exit_policy(self):
        self.assertEqual(push.exit_action(0, None), "stop")
        self.assertEqual(push.exit_action(1, "fatal"), "restart")
        self.assertEqual(push.exit_action(2, None), "stop")
        self.assertEqual(push.exit_action(3, None), "backoff")
        self.assertEqual(push.exit_action(4, "lease-lost"), "restart")
        for reason in ("evicted", "rebound", "revoked", "trust-changed"):
            self.assertEqual(push.exit_action(4, reason), "stop")
        self.assertEqual(push.exit_action(None, None), "restart")

    def test_wake_text_is_fixed_and_body_free(self):
        self.assertNotRegex(push.WAKE_TEXT, r"[0-9a-f]{8}-[0-9a-f]{4}")
        self.assertIn("borg_representative-read", push.WAKE_TEXT)
        self.assertIn("borg_representative-deliver", push.WAKE_TEXT)


class ProtocolTests(Case):
    def test_spawns_protocol_2_with_a_host_pipe(self):
        fake = FakeListener(self.tmp, [[{"emit": LISTENING}, {"eof": True}, {"exit": 0}]])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: fake.invocations()))
        call = fake.invocations()[0]
        self.assertEqual(call["argv"], ["representative", "listen", "--worktree", "/srv/rep-worktree", "--protocol", "2"])
        self.assertTrue(call["stdin_pipe"])

    def test_injects_the_fixed_prompt_and_acks_accepted(self):
        fake = FakeListener(self.tmp, [[{"emit": LISTENING}, {"emit": wake(WAKE1, count=3)}, {"ack": True},
                                         {"emit": wake(WAKE2, "rewake")}, {"ack": True}, {"eof": True}, {"exit": 0}]])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: len(fake.acks()) == 2))
        self.assertEqual(fake.acks(), [{"wake_id": WAKE1, "accepted": True}, {"wake_id": WAKE2, "accepted": True}])
        self.assertEqual(self.injected, [push.WAKE_TEXT, push.WAKE_TEXT])
        self.assertEqual(supervisor.injections, 2)

    def test_acks_refused_when_hermes_declines_or_raises(self):
        for accept in (False, RuntimeError("gateway down")):
            with self.subTest(accept=accept):
                root = self.tmp / str(len(self.supervisors))
                root.mkdir()
                fake = FakeListener(root, [[{"emit": LISTENING}, {"emit": wake(WAKE1)}, {"ack": True}, {"eof": True}, {"exit": 0}]])
                supervisor = self.supervisor(fake, accept=accept)
                supervisor.ensure_started()
                self.assertTrue(wait_until(lambda: fake.acks()))
                self.assertEqual(fake.acks(), [{"wake_id": WAKE1, "accepted": False}])
                self.assertEqual(supervisor.refusals, 1)

    def test_never_puts_event_fields_in_the_prompt(self):
        fake = FakeListener(self.tmp, [[{"emit": LISTENING},
                                         {"emit": {**wake(WAKE1), "message": "BODY_SENTINEL", "from_label": "x"}},
                                         {"ack": True}, {"eof": True}, {"exit": 0}]])
        self.supervisor(fake).ensure_started()
        self.assertTrue(wait_until(lambda: fake.acks()))
        self.assertEqual(self.injected, [push.WAKE_TEXT])

    def test_ignores_unknown_events_and_malformed_wakes(self):
        fake = FakeListener(self.tmp, [[{"emit": LISTENING}, {"emit": "not json"}, {"emit": {"event": "future-event"}},
                                         {"emit": {"event": "wake", "wake_id": "nope"}}, {"emit": wake(WAKE1)}, {"ack": True},
                                         {"eof": True}, {"exit": 0}]])
        self.supervisor(fake).ensure_started()
        self.assertTrue(wait_until(lambda: fake.acks()))
        self.assertEqual(fake.acks(), [{"wake_id": WAKE1, "accepted": True}])
        self.assertEqual(len(self.injected), 1)

    def test_refuses_a_listener_that_does_not_announce_protocol_2(self):
        old = {"event": "listening", "cube_id": "c", "drone_id": "d", "binding_fingerprint": "f" * 64, "watermark": None}
        fake = FakeListener(self.tmp, [[{"emit": old}, {"emit": wake(WAKE1)}, {"eof": True}, {"exit": 0}]])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: supervisor.final_action == "stop"))
        self.assertEqual(supervisor.final_reason, "protocol-mismatch")
        self.assertEqual(self.injected, [])
        self.assertEqual(len(fake.invocations()), 1)  # never restarted

    def test_never_injects_a_wake_that_arrives_before_the_protocol_2_announcement(self):
        # Review probe (S3 F1): wake first, then a protocol-1 announcement.
        fake = FakeListener(self.tmp, [[{"emit": wake(WAKE1)}, {"sleep": 0.1}, {"emit": {"event": "listening", "protocol": 1}},
                                         {"eof": True}, {"exit": 0}]])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: supervisor.final_action == "stop"))
        self.assertEqual(supervisor.final_reason, "protocol-mismatch")
        self.assertEqual(self.injected, [])
        self.assertEqual(fake.acks(), [])

    def test_a_wake_before_listening_is_a_rejection_even_from_a_protocol_2_listener(self):
        fake = FakeListener(self.tmp, [[{"emit": wake(WAKE1)}, {"emit": LISTENING}, {"eof": True}, {"exit": 0}]])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: supervisor.final_action == "stop"))
        self.assertEqual(supervisor.final_reason, "protocol-mismatch")
        self.assertEqual(self.injected, [])

    def test_a_rejected_listener_that_ignores_eof_is_stopped_within_the_deadline(self):
        # Review probe (S3 F2), with the default grace periods: EOF, SIGTERM, SIGKILL.
        fake = FakeListener(self.tmp, [[{"emit": {"event": "listening", "protocol": 1}}, {"sleep": 30}, {"exit": 0}]])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: supervisor._child is not None))
        child = supervisor._child
        finished = wait_until(lambda: supervisor.final_action == "stop", timeout=5.5)
        still_running = child.poll() is None
        if still_running:  # reap only this fixture, even on the failure path
            child.kill()
            child.wait(timeout=3)
        self.assertTrue(finished)
        self.assertFalse(still_running)
        self.assertEqual(supervisor.final_reason, "protocol-mismatch")

    def test_a_rejected_listener_that_ignores_sigterm_is_killed(self):
        fake = FakeListener(self.tmp, [[{"ignore_term": True}, {"emit": {"event": "listening", "protocol": 1}}, {"sleep": 30}, {"exit": 0}]])
        supervisor = self.supervisor(fake, reject_grace_s=0.3)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: supervisor._child is not None))
        child = supervisor._child
        started = time.monotonic()
        finished = wait_until(lambda: supervisor.final_action == "stop", timeout=5)
        elapsed = time.monotonic() - started
        if child.poll() is None:
            child.kill()
            child.wait(timeout=3)
        self.assertTrue(finished)
        self.assertLess(elapsed, 3)
        self.assertEqual(child.returncode, -9)  # SIGKILL after EOF and SIGTERM were ignored

    def test_stops_on_an_older_borg_that_refuses_the_protocol_flag(self):
        fake = FakeListener(self.tmp, [[{"emit": {"event": "refused", "code": "INVALID_INPUT", "exit_code": 2}}, {"exit": 2}]])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: supervisor.final_action == "stop"))
        time.sleep(0.3)
        self.assertEqual(len(fake.invocations()), 1)

    def test_shutdown_closes_the_pipe_and_the_listener_exits_on_eof(self):
        fake = FakeListener(self.tmp, [[{"emit": LISTENING}, {"eof": True}, {"exit": 0}]])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: supervisor._child is not None))
        supervisor.shutdown(timeout=5)
        self.assertTrue(wait_until(lambda: fake.eofs()))
        self.assertEqual(fake.eofs()[0], {"eof": True, "rest": ""})
        time.sleep(0.2)
        self.assertEqual(len(fake.invocations()), 1)

    def test_listener_diagnostics_go_to_the_log_not_the_prompt(self):
        fake = FakeListener(self.tmp, [[{"stderr": "DIAGNOSTIC_SENTINEL " + "x" * 2000}, {"emit": LISTENING},
                                         {"emit": wake(WAKE1)}, {"ack": True}, {"eof": True}, {"exit": 0}]])
        with self.assertLogs(push.logger, level="INFO") as logs:
            self.supervisor(fake).ensure_started()
            self.assertTrue(wait_until(lambda: fake.acks()))
            self.assertTrue(wait_until(lambda: any("DIAGNOSTIC_SENTINEL" in line for line in logs.output)))
        diagnostic = next(line for line in logs.output if "DIAGNOSTIC_SENTINEL" in line)
        self.assertLess(len(diagnostic), push.STDERR_LINE_MAX + 200)
        self.assertEqual(self.injected, [push.WAKE_TEXT])


class RestartPolicyTests(Case):
    def run_policy(self, runs, expected_calls, final=None):
        fake = FakeListener(self.tmp, runs)
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: len(fake.invocations()) >= expected_calls))
        if final:
            self.assertTrue(wait_until(lambda: supervisor.final_action == final))
        time.sleep(0.4)
        return fake, supervisor

    def test_restarts_after_fatal_exit_1_with_backoff(self):
        fake, _ = self.run_policy([[{"exit": 1}], [{"exit": 1}], [{"emit": LISTENING}, {"eof": True}, {"exit": 0}]], 3)
        self.assertEqual(len(fake.invocations()), 3)

    def test_backs_off_and_retries_while_another_listener_holds_the_lease(self):
        owned = [{"emit": {"event": "refused", "code": "REPRESENTATIVE_LISTENER_OWNED", "exit_code": 3}}, {"exit": 3}]
        fake, _ = self.run_policy([owned, owned, [{"emit": LISTENING}, {"eof": True}, {"exit": 0}]], 3)
        self.assertEqual(len(fake.invocations()), 3)

    def test_restarts_after_a_lost_lease(self):
        lost = [{"emit": LISTENING}, {"emit": {"event": "stopped", "reason": "lease-lost", "exit_code": 4}}, {"exit": 4}]
        fake, _ = self.run_policy([lost, [{"emit": LISTENING}, {"eof": True}, {"exit": 0}]], 2)
        self.assertEqual(len(fake.invocations()), 2)

    def test_stops_on_terminal_reasons_and_startup_refusals(self):
        for runs in ([[{"emit": LISTENING}, {"emit": {"event": "stopped", "reason": "rebound", "exit_code": 4}}, {"exit": 4}]],
                     [[{"emit": {"event": "refused", "code": "NOT_PREPARED", "exit_code": 2}}, {"exit": 2}]],
                     [[{"emit": LISTENING}, {"exit": 0}]]):
            with self.subTest(runs=runs):
                self.tmp = Path(tempfile.mkdtemp(dir=self._tmp.name))
                fake, supervisor = self.run_policy(runs, 1, final="stop")
                self.assertEqual(len(fake.invocations()), 1)


class RegistrationTests(Case):
    def test_registers_only_the_platform_handler(self):
        ctx = FakeCtx(settings())
        push.register(ctx)
        self.assertEqual([platform for platform, _ in ctx.platform_handlers], ["telegram"])
        self.assertEqual(ctx.hooks, [])  # no post_tool_call observer in v2

    def test_invalid_settings_disable_the_plugin(self):
        ctx = FakeCtx(settings(worktree="relative"))
        with self.assertLogs(push.logger, level="WARNING"):
            push.register(ctx)
        self.assertEqual(ctx.platform_handlers, [])

    def test_a_platform_reconnect_starts_no_second_listener(self):
        fake = FakeListener(self.tmp, [[{"emit": LISTENING}, {"emit": wake(WAKE1)}, {"ack": True}, {"eof": True}, {"exit": 0}]])
        ctx = FakeCtx(settings(borg_command=str(fake.path)))
        push.register(ctx)
        _, connect = ctx.platform_handlers[0]
        connect()
        connect()
        self.assertTrue(wait_until(lambda: fake.acks()))
        self.assertEqual(len(fake.invocations()), 1)
        self.assertEqual(ctx.injected, [(push.WAKE_TEXT, "user", SESSION_KEY)])

    def test_the_plugin_keeps_no_state_of_its_own(self):
        source = (PLUGIN_DIR / "__init__.py").read_text()
        for gone in ("StateStore", "plugin_data_dir", "post_tool_call", "process_info", "_reap", "parse_delivered",
                     "deliver_tool_name", "reinject", "replay-after", "state.json"):
            self.assertNotIn(gone, source, gone)
        # No file is opened or written by the plugin itself.
        self.assertNotRegex(source, r"(?<![_\w])open\(|os\.open|\.write_text|os\.replace")


if __name__ == "__main__":
    unittest.main()
