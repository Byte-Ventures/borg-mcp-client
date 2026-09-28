"""Unit tests for the borg-representative-push Hermes plugin.

Hermes is not imported: `ctx` is a fake that records registrations and injections,
and `borg` is a fake listener script that prints scripted NDJSON and exits with a
scripted code. Run with: python3 -m unittest discover -s hermes-plugin/tests
"""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import stat
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "borg-representative-push"
_spec = importlib.util.spec_from_file_location("borg_representative_push", PLUGIN_DIR / "__init__.py")
push = importlib.util.module_from_spec(_spec)
sys.modules["borg_representative_push"] = push
_spec.loader.exec_module(push)

SESSION_KEY = "agent:main:telegram:dm:4242"
ID1 = "11111111-1111-4111-8111-111111111111"
ID2 = "22222222-2222-4222-8222-222222222222"
ID3 = "33333333-3333-4333-8333-333333333333"
T1 = "2026-09-28T08:00:01.000Z"
T2 = "2026-09-28T08:00:02.000Z"
T3 = "2026-09-28T08:00:03.000Z"


def entry(entry_id: str, created_at: str, **extra) -> dict:
    return {"event": "entry", "entry_id": entry_id, "created_at": created_at, "from_label": "coordinator-x",
            "from_role": "Coordinator", "visibility": "direct", "request_id": None, "documents": 0,
            "replay": False, **extra}


def deliver_result(entry_id: str, created_at: str) -> str:
    return json.dumps({"checkpoint": {"entry_id": entry_id, "created_at": created_at}, "advanced": True,
                       "binding_fingerprint": "f" * 64})


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
    """An executable `borg` stand-in. Run i uses runs[min(i, last)]."""

    def __init__(self, root: Path, runs: list[dict]):
        self.root = root
        self.spec = root / "spec.json"
        self.calls = root / "calls.jsonl"
        self.spec.write_text(json.dumps({"runs": runs, "calls": str(self.calls)}))
        self.path = root / "fake-borg"
        self.path.write_text(textwrap.dedent(f"""\
            #!{sys.executable}
            import json, sys, time
            spec = json.load(open({str(self.spec)!r}))
            calls = spec["calls"]
            try:
                count = sum(1 for _ in open(calls))
            except OSError:
                count = 0
            with open(calls, "a") as handle:
                handle.write(json.dumps(sys.argv[1:]) + "\\n")
            run = spec["runs"][min(count, len(spec["runs"]) - 1)]
            for line in run.get("lines", []):
                print(json.dumps(line) if isinstance(line, dict) else line, flush=True)
            time.sleep(run.get("hold", 0))
            sys.exit(run.get("exit", 0))
            """))
        self.path.chmod(0o755)

    def invocations(self) -> list[list[str]]:
        try:
            return [json.loads(line) for line in self.calls.read_text().splitlines()]
        except OSError:
            return []


def settings(**overrides) -> dict:
    base = {"session_key": SESSION_KEY, "worktree": "/srv/rep-worktree", "reinject_after_s": 600, "max_reinjects": 3}
    base.update(overrides)
    return base


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.data = self.tmp / "data"
        self.data.mkdir()
        self.supervisors: list = []
        push._SUPERVISOR = None

    def tearDown(self):
        for supervisor in self.supervisors:
            supervisor.shutdown(timeout=2)
        if push._SUPERVISOR is not None:
            push._SUPERVISOR.shutdown(timeout=2)
            push._SUPERVISOR = None
        self._tmp.cleanup()

    def supervisor(self, fake: FakeListener | None = None, inject=None, **kwargs):
        loaded, problem = push.load_settings(FakeCtx(settings(**({"borg_command": str(fake.path)} if fake else {}),
                                                             **kwargs.pop("settings", {}))).get_config)
        self.assertIsNone(problem)
        self.injected: list[str] = []
        sink = inject or (lambda text: self.injected.append(text) or True)
        options = {"data_dir": lambda: self.data, "debounce_s": 0.05, "backoff_start_s": 0.05,
                   "backoff_cap_s": 0.2, "tick_s": 3600}
        options.update(kwargs)
        supervisor = push.Supervisor(loaded, sink, **options)
        self.supervisors.append(supervisor)
        return supervisor


class SettingsTests(unittest.TestCase):
    def test_valid_settings_and_defaults(self):
        loaded, problem = push.load_settings(FakeCtx(settings()).get_config)
        self.assertIsNone(problem)
        self.assertEqual(loaded.platform, "telegram")
        self.assertEqual(loaded.borg_command, "borg")
        self.assertEqual(loaded.mcp_server, "borg-representative")

    def test_invalid_settings_are_rejected_with_a_reason(self):
        cases = [
            {"session_key": None},
            {"session_key": "telegram:dm:1"},
            {"session_key": "agent:main:Tele gram:dm"},
            {"session_key": "agent:main:telegram"},
            {"worktree": "relative/path"},
            {"reinject_after_s": 0},
            {"reinject_after_s": True},
            {"max_reinjects": -1},
            {"borg_command": ""},
        ]
        for override in cases:
            with self.subTest(override=override):
                loaded, problem = push.load_settings(FakeCtx(settings(**override)).get_config)
                self.assertIsNone(loaded)
                self.assertTrue(problem)

    def test_deliver_tool_name_matches_hermes_convention(self):
        self.assertEqual(push.deliver_tool_name("borg-representative"),
                         "mcp__borg_representative__borg_representative_deliver")
        long_name = push.deliver_tool_name("x" * 60)
        self.assertEqual(len(long_name), 64)
        self.assertEqual(long_name, push.deliver_tool_name("x" * 60))

    def test_parse_delivered_accepts_plain_and_enveloped_results_only(self):
        plain = deliver_result(ID1, T1)
        self.assertEqual(push.parse_delivered(plain), {"entry_id": ID1, "created_at": T1})
        envelope = {"content": [{"type": "text", "text": plain}]}
        self.assertEqual(push.parse_delivered(json.dumps(envelope)), {"entry_id": ID1, "created_at": T1})
        self.assertEqual(push.parse_delivered({"result": plain}), {"entry_id": ID1, "created_at": T1})
        self.assertIsNone(push.parse_delivered('{"error": "REPRESENTATIVE_OWNERSHIP_REQUIRED"}'))
        self.assertIsNone(push.parse_delivered("not json"))
        self.assertIsNone(push.parse_delivered(json.dumps({"checkpoint": {"entry_id": None, "created_at": None},
                                                           "advanced": False, "binding_fingerprint": "f"})))

    def test_exit_policy(self):
        self.assertEqual(push.exit_action(0, None), "stop")
        self.assertEqual(push.exit_action(1, "fatal"), "restart")
        self.assertEqual(push.exit_action(2, None), "stop")
        self.assertEqual(push.exit_action(3, None), "owned")
        self.assertEqual(push.exit_action(4, "lease-lost"), "restart")
        for reason in ("evicted", "rebound", "revoked", "trust-changed"):
            self.assertEqual(push.exit_action(4, reason), "stop")
        self.assertEqual(push.exit_action(-9, None), "restart")


class RegisterTests(TempDirCase):
    def test_invalid_settings_register_nothing(self):
        ctx = FakeCtx(settings(session_key=None))
        push.register(ctx)
        self.assertEqual(ctx.platform_handlers, [])
        self.assertEqual(ctx.hooks, [])

    def test_register_starts_nothing_before_the_platform_connects(self):
        fake = FakeListener(self.tmp, [{"lines": [{"event": "listening"}], "hold": 5}])
        ctx = FakeCtx(settings(borg_command=str(fake.path)))
        push.register(ctx)
        self.assertEqual([platform for platform, _ in ctx.platform_handlers], ["telegram"])
        self.assertEqual([name for name, _ in ctx.hooks], ["post_tool_call"])
        time.sleep(0.3)
        self.assertEqual(fake.invocations(), [])
        self.assertIsNone(push._SUPERVISOR)

    def test_platform_connect_starts_one_listener_and_reconnect_is_idempotent(self):
        fake = FakeListener(self.tmp, [{"lines": [{"event": "listening"}], "hold": 5}])
        ctx = FakeCtx(settings(borg_command=str(fake.path)))
        os.environ["HERMES_HOME"] = str(self.tmp / "hermes-home")
        try:
            push.register(ctx)
            factory = ctx.platform_handlers[0][1]
            factory(object(), object())
            first = push._SUPERVISOR
            factory(object(), object())
            self.assertIs(push._SUPERVISOR, first)
            self.assertTrue(wait_until(lambda: len(fake.invocations()) == 1))
            time.sleep(0.3)
            self.assertEqual(len(fake.invocations()), 1)
            self.assertEqual(fake.invocations()[0], ["representative", "listen", "--worktree", "/srv/rep-worktree"])
        finally:
            del os.environ["HERMES_HOME"]

    def test_hook_observes_deliver_and_clears_pending(self):
        fake = FakeListener(self.tmp, [{"lines": [{"event": "listening"}, entry(ID1, T1)], "hold": 5}])
        ctx = FakeCtx(settings(borg_command=str(fake.path)))
        os.environ["HERMES_HOME"] = str(self.tmp / "hermes-home")
        try:
            push.register(ctx)
            ctx.platform_handlers[0][1](None, None)
            supervisor = push._SUPERVISOR
            self.assertTrue(wait_until(lambda: len(ctx.injected) == 1))
            content, role, key = ctx.injected[0]
            self.assertEqual((content, role, key), (push.WAKE_TEXT, "user", SESSION_KEY))
            self.assertIn(ID1, supervisor.pending())
            hook = ctx.hooks[0][1]
            hook(tool_name="mcp__other__borg_representative_deliver", args={}, result=deliver_result(ID1, T1))
            self.assertIn(ID1, supervisor.pending())
            hook(tool_name="mcp__borg_representative__borg_representative_deliver", args={"through": ID1},
                 result=deliver_result(ID1, T1), status="ok", extra_field=1)
            self.assertNotIn(ID1, supervisor.pending())
        finally:
            del os.environ["HERMES_HOME"]


class InjectionTests(TempDirCase):
    def test_burst_of_hints_coalesces_into_one_body_free_wake(self):
        fake = FakeListener(self.tmp, [{"lines": [
            {"event": "listening", "binding_fingerprint": "f" * 64},
            entry(ID1, T1, secret_body="must never appear"),
            entry(ID2, T2),
            {"event": "future-event", "whatever": 1},
            "not json at all",
            entry(ID3, T3),
        ], "hold": 5}])
        supervisor = self.supervisor(fake, debounce_s=0.2)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: len(self.injected) == 1))
        time.sleep(0.4)
        self.assertEqual(self.injected, [push.WAKE_TEXT])
        for forbidden in (ID1, ID2, ID3, "must never appear", "coordinator-x"):
            self.assertNotIn(forbidden, push.WAKE_TEXT)
        self.assertEqual(set(supervisor.pending()), {ID1, ID2, ID3})

    def test_gap_wakes_once_and_is_cleared_by_any_deliver(self):
        supervisor = self.supervisor()
        supervisor.handle_event({"event": "gap", "after": None, "reason": "cursor-expired"})
        supervisor.flush()
        self.assertEqual(self.injected, [push.WAKE_TEXT])
        self.assertIn("gap", supervisor.pending())
        supervisor.observe_delivered({"entry_id": ID1, "created_at": T1})
        self.assertNotIn("gap", supervisor.pending())

    def test_refused_wake_is_not_counted_and_is_retried(self):
        answers = [False, True]
        calls: list[str] = []

        def inject(text):
            calls.append(text)
            return answers.pop(0) if answers else True

        supervisor = self.supervisor(inject=inject, settings={"reinject_after_s": 1})
        supervisor.handle_event(entry(ID1, T1))
        supervisor.flush()
        self.assertEqual(supervisor.pending()[ID1]["count"], 0)
        self.assertTrue(wait_until(lambda: supervisor.pending()[ID1]["count"] == 1, timeout=3))
        self.assertEqual(len(calls), 2)

    def test_reinject_net_wakes_again_until_delivered_and_gives_up_after_max(self):
        now = [1000.0]
        supervisor = self.supervisor(clock=lambda: now[0], settings={"reinject_after_s": 60, "max_reinjects": 2})
        supervisor.handle_event(entry(ID1, T1))
        supervisor.handle_event(entry(ID2, T2))
        supervisor.flush()
        self.assertEqual(len(self.injected), 1)
        now[0] += 30
        supervisor.tick()
        self.assertEqual(len(self.injected), 1)
        # ID1 delivered: only ID2 remains pending.
        supervisor.observe_delivered({"entry_id": ID1, "created_at": T1})
        self.assertEqual(set(supervisor.pending()), {ID2})
        now[0] += 31
        supervisor.tick()
        self.assertEqual(len(self.injected), 2)
        now[0] += 61
        supervisor.tick()
        self.assertEqual(len(self.injected), 3)
        self.assertEqual(supervisor.pending()[ID2]["count"], 3)
        now[0] += 61
        supervisor.tick()
        self.assertEqual(len(self.injected), 3)
        self.assertEqual(supervisor.pending(), {})

    def test_exhausted_wake_budget_survives_replay_until_delivered(self):
        # Review F1 (89a4f23): replaying an exhausted id reset its budget, four wakes with max_reinjects=0.
        now = [1000.0]
        clock = lambda: now[0]
        options = {"clock": clock, "debounce_s": 3600, "settings": {"reinject_after_s": 1, "max_reinjects": 0}}
        supervisor = self.supervisor(**options)
        for _ in range(4):
            supervisor.handle_event(entry(ID2, T2, replay=True))
            supervisor.flush()
            now[0] += 2
            supervisor.tick()
        self.assertEqual(len(self.injected), 1)
        self.assertEqual(supervisor.pending(), {})
        # A new gateway process (same plugin data) replaying the id must not wake either.
        restarted = self.supervisor(**options)
        restarted.handle_event(entry(ID2, T2, replay=True))
        restarted.flush()
        self.assertEqual(len(self.injected), 0)
        # A later reply is still woken, and delivery through it forgets the exhausted id.
        restarted.handle_event(entry(ID3, T3))
        restarted.flush()
        self.assertEqual(len(self.injected), 1)
        self.assertEqual(set(json.loads((self.data / "state.json").read_text())["wakes"]), {ID2, ID3})
        restarted.observe_delivered({"entry_id": ID3, "created_at": T3})
        saved = json.loads((self.data / "state.json").read_text())
        self.assertEqual(saved["wakes"], {})

    def test_exhausted_gap_is_not_rewoken_until_a_deliver(self):
        now = [1000.0]
        supervisor = self.supervisor(clock=lambda: now[0], debounce_s=3600,
                                     settings={"reinject_after_s": 1, "max_reinjects": 0})
        for _ in range(3):
            supervisor.handle_event({"event": "gap", "after": None, "reason": "replay-checkpoint-missing"})
            supervisor.flush()
            now[0] += 2
            supervisor.tick()
        self.assertEqual(len(self.injected), 1)
        supervisor.observe_delivered({"entry_id": ID1, "created_at": T1})
        supervisor.handle_event({"event": "gap", "after": None, "reason": "cursor-expired"})
        supervisor.flush()
        self.assertEqual(len(self.injected), 2)

    def test_spent_records_are_never_dropped_before_delivery(self):
        # Review F1a (122d199): a 256-record cap evicted undelivered spent ids, renewing their budget.
        now = [1000.0]
        supervisor = self.supervisor(clock=lambda: now[0], debounce_s=3600,
                                     settings={"reinject_after_s": 1, "max_reinjects": 0})
        ids = [(f"{i:08x}-0000-4000-8000-000000000000", f"2026-09-28T08:{i // 60:02d}:{i % 60:02d}.000Z")
               for i in range(257)]
        for entry_id, created_at in ids:
            supervisor.handle_event(entry(entry_id, created_at))
            supervisor.flush()
            now[0] += 2
            supervisor.tick()
        self.assertEqual(len(self.injected), 257)
        for _ in range(3):
            supervisor.handle_event(entry(*ids[0], replay=True))
            supervisor.flush()
            now[0] += 2
            supervisor.tick()
        self.assertEqual(len(self.injected), 257)
        # Only a delivery covering a record removes it.
        supervisor.observe_delivered({"entry_id": ids[99][0], "created_at": ids[99][1]})
        saved = json.loads((self.data / "state.json").read_text())["wakes"]
        self.assertEqual(len(saved), 157)
        self.assertNotIn(ids[99][0], saved)
        self.assertIn(ids[100][0], saved)

    def test_accepted_wake_is_persisted_before_a_restart(self):
        # Review F1b (122d199): counts lived in memory until a later tick; four restarts gave four wakes.
        wakes: list[str] = []
        for _ in range(4):
            supervisor = self.supervisor(inject=lambda text: wakes.append(text) or True, debounce_s=3600,
                                         settings={"reinject_after_s": 600, "max_reinjects": 0})
            supervisor.handle_event(entry(ID2, T2, replay=True))
            supervisor.flush()
            supervisor.shutdown()
        self.assertEqual(len(wakes), 1)
        saved = json.loads((self.data / "state.json").read_text())["wakes"]
        self.assertEqual(saved[ID2]["count"], 1)

    def test_partial_budget_survives_restart(self):
        now = [1000.0]
        wakes: list[str] = []
        sink = lambda text: wakes.append(text) or True
        options = {"inject": sink, "clock": lambda: now[0], "debounce_s": 3600,
                   "settings": {"reinject_after_s": 60, "max_reinjects": 1}}
        first = self.supervisor(**options)
        first.handle_event(entry(ID2, T2))
        first.flush()
        first.shutdown()
        self.assertEqual(len(wakes), 1)
        second = self.supervisor(**options)
        second.handle_event(entry(ID2, T2, replay=True))
        second.flush()
        self.assertEqual(len(wakes), 1)  # already woken once: no immediate wake after restart
        now[0] += 61
        second.tick()
        self.assertEqual(len(wakes), 2)  # the one allowed repeat
        second.shutdown()
        third = self.supervisor(**options)
        third.handle_event(entry(ID2, T2, replay=True))
        third.flush()
        now[0] += 61
        third.tick()
        self.assertEqual(len(wakes), 2)  # spent: no more wakes until delivered

    def test_refused_wake_does_not_consume_the_persisted_budget(self):
        supervisor = self.supervisor(inject=lambda text: False, debounce_s=3600)
        supervisor.handle_event(entry(ID1, T1))
        supervisor.flush()
        supervisor.shutdown()
        state_file = self.data / "state.json"
        saved = json.loads(state_file.read_text()).get("wakes", {}) if state_file.exists() else {}
        self.assertEqual(saved.get(ID1, {}).get("count", 0), 0)

    def test_delivered_hint_is_not_pending_and_a_later_deliver_clears_all_earlier(self):
        supervisor = self.supervisor()
        supervisor.handle_event(entry(ID1, T1))
        supervisor.handle_event(entry(ID2, T2))
        supervisor.handle_event(entry(ID3, T3))
        supervisor.observe_delivered({"entry_id": ID2, "created_at": T2})
        self.assertEqual(set(supervisor.pending()), {ID3})
        supervisor.handle_event(entry(ID1, T1, replay=True))
        self.assertEqual(set(supervisor.pending()), {ID3})


class ListenerLifecycleTests(TempDirCase):
    def run_until_done(self, supervisor, fake, expected_runs, settle=0.4):
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: len(fake.invocations()) >= expected_runs))
        time.sleep(settle)
        return len(fake.invocations())

    def test_exit_0_does_not_restart(self):
        fake = FakeListener(self.tmp, [{"lines": [{"event": "stopped", "reason": "signal", "exit_code": 0}], "exit": 0}])
        supervisor = self.supervisor(fake)
        self.assertEqual(self.run_until_done(supervisor, fake, 1), 1)
        self.assertEqual(supervisor.final_action, "stop")

    def test_exit_1_restarts_with_backoff(self):
        fake = FakeListener(self.tmp, [{"lines": [{"event": "refused", "code": "REPRESENTATIVE_LISTENER_STORAGE_REFUSED",
                                                    "exit_code": 1}], "exit": 1},
                                       {"lines": [{"event": "listening"}], "hold": 5}])
        supervisor = self.supervisor(fake)
        self.assertGreaterEqual(self.run_until_done(supervisor, fake, 2), 2)

    def test_exit_2_stops_and_logs(self):
        fake = FakeListener(self.tmp, [{"lines": [{"event": "refused", "code": "NOT_PREPARED", "exit_code": 2}], "exit": 2}])
        supervisor = self.supervisor(fake)
        with self.assertLogs(push.logger, level="WARNING") as logs:
            self.assertEqual(self.run_until_done(supervisor, fake, 1), 1)
        self.assertEqual(supervisor.final_action, "stop")
        self.assertTrue(any("NOT_PREPARED" in line for line in logs.output))

    def test_exit_3_without_a_recorded_orphan_backs_off_and_retries(self):
        kills: list = []
        fake = FakeListener(self.tmp, [{"lines": [{"event": "refused", "code": "REPRESENTATIVE_LISTENER_OWNED",
                                                    "exit_code": 3, "owner_pid": 999999, "owner_started_at": T1}],
                                         "exit": 3},
                                       {"lines": [{"event": "listening"}], "hold": 5}])
        supervisor = self.supervisor(fake, kill=lambda pid, sig: kills.append((pid, sig)))
        self.assertGreaterEqual(self.run_until_done(supervisor, fake, 2), 2)
        self.assertEqual(kills, [])

    def test_exit_4_restarts_only_on_lease_lost(self):
        lost = FakeListener(self.tmp, [{"lines": [{"event": "listening"},
                                                  {"event": "stopped", "reason": "lease-lost", "exit_code": 4}],
                                        "exit": 4},
                                       {"lines": [{"event": "listening"}], "hold": 5}])
        self.assertGreaterEqual(self.run_until_done(self.supervisor(lost), lost, 2), 2)
        other = self.tmp / "evicted"
        other.mkdir()
        evicted = FakeListener(other, [{"lines": [{"event": "listening"},
                                                  {"event": "stopped", "reason": "evicted", "exit_code": 4}],
                                        "exit": 4}])
        supervisor = self.supervisor(evicted)
        self.assertEqual(self.run_until_done(supervisor, evicted, 1), 1)
        self.assertEqual(supervisor.final_action, "stop")

    def assert_terminal_stop_retires_wakes(self, lines, code):
        # Review F2 (89a4f23): after a terminal stop a queued debounce and a pending repeat still woke.
        fake = FakeListener(self.tmp, [{"lines": lines, "exit": code}])
        now = [1000.0]
        supervisor = self.supervisor(fake, clock=lambda: now[0], debounce_s=3600,
                                     settings={"reinject_after_s": 1, "max_reinjects": 1})
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: supervisor.final_action == "stop"))
        supervisor.flush()
        now[0] += 2
        supervisor.tick()
        self.assertEqual(self.injected, [])
        self.assertTrue(supervisor._stopping.is_set())
        self.assertEqual(supervisor.pending(), {})

    def test_terminal_exit_4_retires_queued_and_repeat_wakes(self):
        self.assert_terminal_stop_retires_wakes(
            [{"event": "listening"}, entry(ID1, T1), {"event": "stopped", "reason": "evicted", "exit_code": 4}], 4)

    def test_exit_2_retires_queued_and_repeat_wakes(self):
        self.assert_terminal_stop_retires_wakes(
            [{"event": "listening"}, entry(ID1, T1), {"event": "refused", "code": "BINDING_MISMATCH", "exit_code": 2}], 2)

    def test_terminal_stop_after_a_wake_stops_repeats(self):
        fake = FakeListener(self.tmp, [{"lines": [{"event": "listening"}, entry(ID1, T1)], "hold": 0.5, "exit": 4}])
        now = [1000.0]
        supervisor = self.supervisor(fake, clock=lambda: now[0], settings={"reinject_after_s": 1, "max_reinjects": 3})
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: len(self.injected) == 1))
        self.assertTrue(wait_until(lambda: supervisor.final_action == "stop"))
        now[0] += 2
        supervisor.tick()
        self.assertEqual(len(self.injected), 1)

    def test_replay_after_uses_the_observed_delivered_checkpoint(self):
        push.StateStore(self.data).save({"delivered": {"entry_id": ID2, "created_at": T2}})
        fake = FakeListener(self.tmp, [{"lines": [{"event": "listening"}], "hold": 0.5, "exit": 1},
                                       {"lines": [{"event": "listening"}], "hold": 5}])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: len(fake.invocations()) >= 1))
        self.assertEqual(fake.invocations()[0][-2:], ["--replay-after", ID2])
        supervisor.observe_delivered({"entry_id": ID3, "created_at": T3})
        self.assertTrue(wait_until(lambda: len(fake.invocations()) >= 2))
        self.assertEqual(fake.invocations()[1][-2:], ["--replay-after", ID3])
        saved = json.loads((self.data / "state.json").read_text())
        self.assertEqual(saved["delivered"], {"entry_id": ID3, "created_at": T3})
        self.assertEqual(stat.S_IMODE((self.data / "state.json").stat().st_mode), 0o600)

    def test_listening_child_is_recorded_for_orphan_detection(self):
        fake = FakeListener(self.tmp, [{"lines": [{"event": "listening"}], "hold": 5}])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        state_file = self.data / "state.json"
        self.assertTrue(wait_until(lambda: state_file.exists() and "child" in json.loads(state_file.read_text())))
        child = json.loads(state_file.read_text())["child"]
        self.assertEqual(child["parent"], os.getpid())
        self.assertIsInstance(child["pid"], int)

    def test_shutdown_terminates_the_child(self):
        fake = FakeListener(self.tmp, [{"lines": [{"event": "listening"}], "hold": 30}])
        supervisor = self.supervisor(fake)
        supervisor.ensure_started()
        self.assertTrue(wait_until(lambda: supervisor._child is not None and len(fake.invocations()) == 1))
        child = supervisor._child
        supervisor.shutdown(timeout=5)
        self.assertIsNotNone(child.poll())
        time.sleep(0.3)
        self.assertEqual(len(fake.invocations()), 1)


class ReapTests(TempDirCase):
    RECORD = {"pid": 4321, "parent": 1111, "started": "Mon Sep 28 08:00:00 2026"}

    def reaper(self, info):
        kills: list = []
        supervisor = self.supervisor(info=lambda pid: info, kill=lambda pid, sig: kills.append((pid, sig)))
        supervisor._state = {"child": dict(self.RECORD)}
        return supervisor, kills

    def test_reaps_only_the_recorded_reparented_listener(self):
        supervisor, kills = self.reaper((1, self.RECORD["started"], "node /x/borg representative listen --worktree /w"))
        self.assertTrue(supervisor._reap(4321))
        self.assertEqual(kills, [(4321, signal.SIGTERM)])

    def test_does_not_reap_other_pids_reused_pids_live_parents_or_other_commands(self):
        started = self.RECORD["started"]
        cases = [
            (5555, (1, started, "borg representative listen")),                  # not the recorded pid
            (4321, (1, "Tue Sep 29 09:00:00 2026", "borg representative listen")),  # pid reused
            (4321, (1111, started, "borg representative listen")),               # original parent alive
            (4321, (os.getpid(), started, "borg representative listen")),        # our own child
            (4321, (1, started, "/usr/bin/some-other-program")),                 # not a listener
            (4321, None),                                                        # gone
            (True, (1, started, "borg representative listen")),                  # malformed pid
        ]
        for owner_pid, info in cases:
            with self.subTest(owner_pid=owner_pid, info=info):
                supervisor, kills = self.reaper(info)
                self.assertFalse(supervisor._reap(owner_pid))
                self.assertEqual(kills, [])


if __name__ == "__main__":
    unittest.main()
