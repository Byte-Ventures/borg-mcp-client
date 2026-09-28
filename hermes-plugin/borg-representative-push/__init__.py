"""Borg representative push: a Borg-owned Hermes user plugin (v2, listener protocol 2).

When the bound Borg Coordinator replies to the human representative, this plugin
wakes the one Hermes *messaging-gateway* conversation named by
``plugins.entries.borg-representative-push.settings.session_key``.

It is a thin adapter. Borg owns every wake decision and all wake state:

- The plugin runs ``borg representative listen --worktree <path> --protocol 2``
  (borgmcp >= 6.0.0) with a stdin pipe it owns.
- On each ``wake`` event it calls ``ctx.inject_message`` with one fixed, body-free
  prompt and writes Hermes's answer back as ``{"wake_id": ..., "accepted": bool}``.
- The listener decides when to wake again, backs off when Hermes refuses, and
  stops waking once the conversation delivers the reply. Reply content never
  passes through the plugin: the woken conversation fetches it with
  ``borg_representative-read`` and confirms it with ``borg_representative-deliver``.

The listener starts only from ``ctx.register_platform_handler``, which Hermes calls
when a gateway platform connects, so it never runs in the CLI, the Desktop backend
(``hermes serve``) or worker processes. When the gateway exits, even by SIGKILL,
the kernel closes the pipe and the listener exits on EOF: nothing is left behind.

Standard library only.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import re
import subprocess
import threading
from typing import Any, Callable, NamedTuple, Optional

PLUGIN_NAME = "borg-representative-push"
PROTOCOL = 2

# Fixed and body-free: no entry id, sender, text or document ever enters the prompt.
WAKE_TEXT = (
    "Borg: new Coordinator reply. Call borg_representative-read, persist and relay, "
    "then borg_representative-deliver through the last persisted entry_id."
)

BACKOFF_START_S = 1.0
BACKOFF_CAP_S = 60.0
# A rejected listener gets this long after EOF, then after SIGTERM, before SIGKILL.
REJECT_GRACE_S = 2.0
STDERR_LINE_MAX = 500

logger = logging.getLogger(__name__)

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_PLATFORM = re.compile(r"^[a-z0-9_-]+$")


class Settings(NamedTuple):
    session_key: str
    platform: str
    worktree: str
    borg_command: str


def load_settings(get: Callable[..., Any]) -> tuple[Optional[Settings], Optional[str]]:
    """Validate this plugin's settings; return (settings, None) or (None, reason)."""

    session_key = get("session_key", default=None)
    if not isinstance(session_key, str) or not session_key.strip():
        return None, "settings.session_key is required (a gateway session key such as agent:main:telegram:dm:<chat id>)"
    parts = session_key.split(":")
    if len(parts) < 4 or parts[0] != "agent" or not all(parts) or not _PLATFORM.match(parts[2]):
        return None, "settings.session_key must look like agent:main:<platform>:<chat type>[:<chat id>...]"
    worktree = get("worktree", default=None)
    if not isinstance(worktree, str) or not os.path.isabs(worktree):
        return None, "settings.worktree must be the absolute path of the prepared representative worktree"
    borg_command = get("borg_command", default="borg")
    if not isinstance(borg_command, str) or not borg_command.strip() or "\n" in borg_command:
        return None, "settings.borg_command must be a non-empty executable name or path"
    return Settings(session_key, parts[2], worktree, borg_command), None


def exit_action(code: Optional[int], stop_reason: Optional[str]) -> str:
    """Listener exit policy: "stop", "restart" or "backoff" (see docs/HUMAN_REPRESENTATIVE.md).

    0: stopped by us (EOF or signal); 2: startup refusal the operator must fix;
    3: another listener holds the lease; 4: terminal stop, except a lost lease.
    """
    if code in (0, 2):
        return "stop"
    if code == 3:
        return "backoff"
    if code == 4:
        return "restart" if stop_reason == "lease-lost" else "stop"
    return "restart"  # 1 (fatal) or anything unexpected: capped backoff


class Supervisor:
    """Process-singleton owner of one `borg representative listen --protocol 2` child."""

    def __init__(
        self,
        settings: Settings,
        inject: Callable[[str], bool],
        *,
        popen: Callable[..., Any] = subprocess.Popen,
        backoff_start_s: float = BACKOFF_START_S,
        backoff_cap_s: float = BACKOFF_CAP_S,
        reject_grace_s: float = REJECT_GRACE_S,
    ):
        self.settings = settings
        self._inject = inject
        self._popen = popen
        self._backoff_start_s = backoff_start_s
        self._backoff_cap_s = backoff_cap_s
        self._reject_grace_s = reject_grace_s
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self._started = False
        self._child: Any = None
        self.injections = 0
        self.refusals = 0
        self.final_action: Optional[str] = None
        self.final_reason: Optional[str] = None

    def ensure_started(self) -> bool:
        """Start once; a platform reconnect calls this again and changes nothing."""
        with self._lock:
            if self._started:
                return False
            self._started = True
        threading.Thread(target=self._run, name=f"{PLUGIN_NAME}:listener", daemon=True).start()
        return True

    def shutdown(self, timeout: float = 5.0) -> None:
        """Close the pipe: the listener sees EOF and exits 0."""
        self._stopping.set()
        with self._lock:
            child = self._child
        if child is None or child.poll() is not None:
            return
        try:
            child.stdin.close()
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            child.terminate()
        except (OSError, ValueError):
            # Ignored: shutdown is best-effort; a closed pipe or failed wait leaves the exit to the run loop.
            pass

    def _run(self) -> None:
        delay = self._backoff_start_s
        while not self._stopping.is_set():
            code, stop_reason, listening = self._run_once()
            if self._stopping.is_set():
                break
            action = exit_action(code, stop_reason)
            if action == "stop":
                self.final_action, self.final_reason = "stop", stop_reason
                if code != 0:
                    logger.warning("%s: listener stopped (exit %s, %s); not restarting until the gateway restarts",
                                   PLUGIN_NAME, code, stop_reason or "no reason")
                return
            if listening:
                delay = self._backoff_start_s  # a listener that got going resets the backoff
            if self._stopping.wait(delay):
                break
            delay = min(delay * 2, self._backoff_cap_s)

    def _run_once(self) -> tuple[Optional[int], Optional[str], bool]:
        s = self.settings
        args = [s.borg_command, "representative", "listen", "--worktree", s.worktree, "--protocol", str(PROTOCOL)]
        try:
            # close_fds: the pipe's write end stays in this process only, so the
            # listener sees EOF when the gateway exits for any reason.
            child = self._popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, bufsize=1, close_fds=True)
        except OSError as error:
            logger.warning("%s: cannot start %s: %s", PLUGIN_NAME, s.borg_command, error)
            return 1, None, False
        with self._lock:
            self._child = child
            if self._stopping.is_set():
                self._close(child)  # shutdown raced this spawn
        drain = threading.Thread(target=self._drain_stderr, args=(child,), name=f"{PLUGIN_NAME}:stderr", daemon=True)
        drain.start()
        stop_reason: Optional[str] = None
        listening = False
        rejected = False
        for line in child.stdout:
            event = self._parse(line)
            if event is None:
                continue
            kind = event.get("event")
            if not listening:
                # A gate: nothing is acted on before a protocol-2 announcement. Only
                # `refused` (a protocol-2 startup refusal, before `listening`) is expected.
                if kind == "refused":
                    stop_reason = event.get("code") if isinstance(event.get("code"), str) else None
                    continue
                if kind == "listening" and event.get("protocol") == PROTOCOL:
                    listening = True
                    logger.info("%s: listening (binding %s)", PLUGIN_NAME, event.get("binding_fingerprint"))
                    continue
                # An older listener, or an event before the announcement: never drive it.
                logger.warning("%s: the listener did not announce protocol %d before %r; update borgmcp",
                               PLUGIN_NAME, PROTOCOL, kind)
                rejected = True
                self._reject(child)
                break
            if kind == "wake":
                self._wake(child, event)
            elif kind == "stopped":
                stop_reason = event.get("reason") if isinstance(event.get("reason"), str) else None
            # Unknown events and fields are ignored by contract.
        code = child.wait()
        drain.join(timeout=5)
        for stream in (child.stdin, child.stdout, child.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                # Ignored: closing is best-effort cleanup after the child was reaped.
                pass
        with self._lock:
            self._child = None
        if rejected:
            return 2, "protocol-mismatch", False
        return code, stop_reason, listening

    def _wake(self, child: Any, event: dict) -> None:
        wake_id = event.get("wake_id")
        if not isinstance(wake_id, str) or not _UUID.match(wake_id):
            return
        try:
            accepted = bool(self._inject(WAKE_TEXT))
        except Exception:  # the host API must never take the supervisor down
            logger.warning("%s: inject_message raised", PLUGIN_NAME, exc_info=True)
            accepted = False
        if accepted:
            self.injections += 1
        else:
            self.refusals += 1
            if self.refusals == 1 or self.refusals % 10 == 0:
                logger.warning("%s: Hermes did not accept the wake (%d refusals); check allow_gateway_injection "
                               "and settings.session_key", PLUGIN_NAME, self.refusals)
        try:
            child.stdin.write(json.dumps({"wake_id": wake_id, "accepted": accepted}) + "\n")
            child.stdin.flush()
        except (OSError, ValueError):
            pass  # the listener is gone; its exit is handled by the run loop

    def _reject(self, child: Any) -> None:
        """End a rejected child without trusting it: EOF, then SIGTERM, then SIGKILL, each after a grace period."""
        self._close(child)
        for signal_child in (None, child.terminate, child.kill):
            if signal_child is not None:
                try:
                    signal_child()
                except OSError:
                    # Ignored: signalling is best-effort; the wait and escalation below remain responsible for cleanup.
                    pass
            try:
                child.wait(timeout=self._reject_grace_s)
                return
            except subprocess.TimeoutExpired:
                continue
        child.wait()  # SIGKILL cannot be ignored: reap it

    @staticmethod
    def _close(child: Any) -> None:
        try:
            child.stdin.close()
        except (OSError, ValueError):
            # Ignored: closing stdin is best-effort; the caller's wait and escalation handle the child.
            pass

    @staticmethod
    def _drain_stderr(child: Any) -> None:
        """Listener diagnostics go to the Hermes log, never to the prompt."""
        try:
            for line in child.stderr:
                text = line.rstrip()
                if text:
                    logger.info("%s: listener: %s", PLUGIN_NAME, text[:STDERR_LINE_MAX])
        except (OSError, ValueError):
            # Ignored: draining is best-effort diagnostics; the run loop handles the listener's exit.
            pass

    @staticmethod
    def _parse(line: str) -> Optional[dict]:
        try:
            event = json.loads(line)
        except ValueError:
            return None
        return event if isinstance(event, dict) else None


_SUPERVISOR: Optional[Supervisor] = None
_SUPERVISOR_LOCK = threading.Lock()


def _start(settings: Settings, ctx: Any) -> Supervisor:
    global _SUPERVISOR
    with _SUPERVISOR_LOCK:
        if _SUPERVISOR is None:
            _SUPERVISOR = Supervisor(
                settings,
                lambda text: ctx.inject_message(text, role="user", session_key=settings.session_key),
            )
        supervisor = _SUPERVISOR
    supervisor.ensure_started()
    return supervisor


def _shutdown() -> None:
    with _SUPERVISOR_LOCK:
        supervisor = _SUPERVISOR
    if supervisor is not None:
        supervisor.shutdown()


def register(ctx: Any) -> None:
    try:
        settings, problem = load_settings(ctx.get_config)
    except Exception as error:  # an unreadable config must not break Hermes startup
        settings, problem = None, f"settings could not be read: {error}"
    if settings is None:
        logger.warning("%s: disabled: %s", PLUGIN_NAME, problem)
        return

    def on_platform_connect(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        _start(settings, ctx)

    ctx.register_platform_handler(settings.platform, on_platform_connect)
    atexit.register(_shutdown)
