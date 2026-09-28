"""Borg representative push: a Borg-owned Hermes user plugin.

When the bound Borg Coordinator replies to the human representative, this plugin
wakes the one Hermes *messaging-gateway* conversation named by
``plugins.entries.borg-representative-push.settings.session_key``.

- It supervises ``borg representative listen`` (borgmcp >= 5.6.0), which emits
  body-free JSON wake hints on stdout.
- It turns those hints into one fixed, body-free ``ctx.inject_message`` prompt.
  Reply content never passes through the plugin: the woken conversation fetches it
  with ``borg_representative-read`` and confirms it with
  ``borg_representative-deliver``.

The listener starts only from ``ctx.register_platform_handler``, which Hermes calls
when a gateway platform connects, so it never runs in the CLI, the Desktop backend
(``hermes serve``) or worker processes. A Desktop chat cannot be woken: Hermes's
``inject_message`` reaches only CLI and messaging-gateway conversations.

Standard library only.
"""

from __future__ import annotations

import atexit
import hashlib
import json
import logging
import os
import re
import signal
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, NamedTuple, Optional

PLUGIN_NAME = "borg-representative-push"

# Fixed and body-free: no entry id, sender, text or document ever enters the prompt.
WAKE_TEXT = (
    "Borg: new Coordinator reply. Call borg_representative-read, persist and relay, "
    "then borg_representative-deliver through the last persisted entry_id."
)

DEBOUNCE_S = 2.0
BACKOFF_START_S = 1.0
BACKOFF_CAP_S = 60.0
INJECT_RETRY_CAP_S = 30.0
STATE_VERSION = 1

logger = logging.getLogger(__name__)

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_PLATFORM = re.compile(r"^[a-z0-9_-]+$")


class Settings(NamedTuple):
    session_key: str
    platform: str
    worktree: str
    borg_command: str
    mcp_server: str
    reinject_after_s: int
    max_reinjects: int


def load_settings(get: Callable[..., Any]) -> tuple[Optional[Settings], Optional[str]]:
    """Validate this plugin's settings; return (settings, None) or (None, reason)."""

    def value(key: str, default: Any = None) -> Any:
        return get(key, default=default)

    session_key = value("session_key")
    if not isinstance(session_key, str) or not session_key.strip():
        return None, "settings.session_key is required (a gateway session key such as agent:main:telegram:dm:<chat id>)"
    parts = session_key.split(":")
    if len(parts) < 4 or parts[0] != "agent" or not all(parts) or not _PLATFORM.match(parts[2]):
        return None, "settings.session_key must look like agent:main:<platform>:<chat type>[:<chat id>...]"
    worktree = value("worktree")
    if not isinstance(worktree, str) or not os.path.isabs(worktree):
        return None, "settings.worktree must be the absolute path of the prepared representative worktree"
    borg_command = value("borg_command", "borg")
    if not isinstance(borg_command, str) or not borg_command.strip() or "\n" in borg_command:
        return None, "settings.borg_command must be a non-empty executable name or path"
    mcp_server = value("mcp_server", "borg-representative")
    if not isinstance(mcp_server, str) or not mcp_server.strip():
        return None, "settings.mcp_server must name the mcp_servers entry that runs `borg representative mcp`"
    reinject_after_s = value("reinject_after_s", 600)
    if isinstance(reinject_after_s, bool) or not isinstance(reinject_after_s, int) or reinject_after_s < 1:
        return None, "settings.reinject_after_s must be a positive integer"
    max_reinjects = value("max_reinjects", 3)
    if isinstance(max_reinjects, bool) or not isinstance(max_reinjects, int) or max_reinjects < 0:
        return None, "settings.max_reinjects must be a non-negative integer"
    return Settings(session_key, parts[2], worktree, borg_command, mcp_server, reinject_after_s, max_reinjects), None


def _sanitize(component: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", str(component or ""))


def deliver_tool_name(server: str) -> str:
    """Hermes's registry name for the deliver tool on ``server``.

    The ``mcp__<server>__<tool>`` convention is documented. The sanitising and the
    64-character hash clamp mirror Hermes's ``mcp_prefixed_tool_name``, which is
    undocumented.
    """
    full = f"mcp__{_sanitize(server)}__{_sanitize('borg_representative-deliver')}"
    if len(full) <= 64:
        return full
    suffix = "_" + hashlib.sha256(full.encode("utf-8")).hexdigest()[:8]
    return full[: 64 - len(suffix)] + suffix


def _instant(created_at: Any) -> Optional[datetime]:
    if not isinstance(created_at, str):
        return None
    try:
        parsed = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _point(entry_id: Any, created_at: Any) -> Optional[tuple[datetime, str]]:
    """Checkpoint order: (created_at, id), as the delivered checkpoint compares entries."""
    instant = _instant(created_at)
    if instant is None or not isinstance(entry_id, str) or not _UUID.match(entry_id):
        return None
    return instant, entry_id.lower()


def parse_delivered(result: Any, depth: int = 0) -> Optional[dict]:
    """Find a borg_representative-deliver result ({checkpoint, advanced, binding_fingerprint}).

    Returns {"entry_id", "created_at"} of the checkpoint, or None when the result is
    not a successful deliver (an error, a refusal or an unrecognised shape).
    """
    if depth > 5:
        return None
    if isinstance(result, (bytes, bytearray)):
        result = result.decode("utf-8", "replace")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            return None
    if isinstance(result, dict):
        checkpoint = result.get("checkpoint")
        if isinstance(checkpoint, dict) and "binding_fingerprint" in result and "advanced" in result:
            if _point(checkpoint.get("entry_id"), checkpoint.get("created_at")) is None:
                return None
            return {"entry_id": checkpoint["entry_id"], "created_at": checkpoint["created_at"]}
        for key in ("structuredContent", "result", "content", "text"):
            if key in result:
                found = parse_delivered(result[key], depth + 1)
                if found:
                    return found
        return None
    if isinstance(result, list):
        for item in result[:8]:
            found = parse_delivered(item, depth + 1)
            if found:
                return found
    return None


def exit_action(code: Optional[int], stop_reason: Optional[str]) -> str:
    """Listener exit policy: "stop", "restart" or "owned" (see docs/HUMAN_REPRESENTATIVE.md)."""
    if code == 0:
        return "stop"  # SIGTERM/SIGINT: our own shutdown
    if code == 2:
        return "stop"  # startup binding or usage refusal: the operator must act
    if code == 3:
        return "owned"  # another listener holds the lease
    if code == 4:
        return "restart" if stop_reason == "lease-lost" else "stop"
    return "restart"  # 1 (fatal) or anything unexpected: capped backoff


def process_info(pid: int) -> Optional[tuple[int, str, str]]:
    """(ppid, start time, command) of a live process, via ps; None when unavailable."""
    try:
        completed = subprocess.run(
            ["ps", "-o", "ppid=", "-o", "lstart=", "-o", "command=", "-p", str(int(pid))],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    tokens = completed.stdout.split()
    if completed.returncode != 0 or len(tokens) < 7:
        return None
    try:
        ppid = int(tokens[0])
    except ValueError:
        return None
    return ppid, " ".join(tokens[1:6]), " ".join(tokens[6:])


def default_data_dir() -> Path:
    """<hermes home>/plugin-data/borg-representative-push, created private."""
    try:
        from plugins.plugin_storage import plugin_data_dir  # Hermes's sanctioned plugin data root

        directory = Path(plugin_data_dir(PLUGIN_NAME))
    except ImportError:
        home = os.environ.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
        directory = Path(home) / "plugin-data" / PLUGIN_NAME
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    return directory


class StateStore:
    """state.json: the recorded listener child and the observed delivered checkpoint."""

    def __init__(self, directory: Path):
        self.path = Path(directory) / "state.json"

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) and data.get("version") == STATE_VERSION else {}

    def save(self, data: dict) -> None:
        payload = json.dumps({**data, "version": STATE_VERSION}, sort_keys=True).encode("utf-8")
        temporary = self.path.with_name(f".state.{os.getpid()}.{threading.get_ident()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(descriptor, payload)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, self.path)


class Supervisor:
    """Process-singleton owner of one `borg representative listen` child."""

    def __init__(
        self,
        settings: Settings,
        inject: Callable[[str], bool],
        *,
        data_dir: Callable[[], Path] = default_data_dir,
        popen: Callable[..., Any] = subprocess.Popen,
        info: Callable[[int], Optional[tuple[int, str, str]]] = process_info,
        kill: Callable[[int, int], None] = os.kill,
        clock: Callable[[], float] = time.monotonic,
        debounce_s: float = DEBOUNCE_S,
        backoff_start_s: float = BACKOFF_START_S,
        backoff_cap_s: float = BACKOFF_CAP_S,
        tick_s: Optional[float] = None,
    ):
        self.settings = settings
        self._inject = inject
        self._data_dir = data_dir
        self._popen = popen
        self._info = info
        self._kill = kill
        self._clock = clock
        self._debounce_s = debounce_s
        self._backoff_start_s = backoff_start_s
        self._backoff_cap_s = backoff_cap_s
        self._tick_s = tick_s if tick_s is not None else min(30.0, max(settings.reinject_after_s / 2, 0.05))
        self._retry_s = min(INJECT_RETRY_CAP_S, float(settings.reinject_after_s))
        self._lock = threading.RLock()
        self._stopping = threading.Event()
        self._started = False
        self._store: Optional[StateStore] = None
        self._state: dict = {}
        self._child: Any = None
        self._spawned: Optional[dict] = None
        self._pending: dict[str, dict] = {}
        self._flush_timer: Optional[threading.Timer] = None
        self._inject_failures = 0
        self._listening = False
        self.injections = 0
        self.final_action: Optional[str] = None

    # ---- lifecycle -----------------------------------------------------------------

    def ensure_started(self) -> bool:
        """Start once; a platform reconnect calls this again and changes nothing."""
        with self._lock:
            if self._started:
                return False
            self._ensure_state()
            self._started = True
        threading.Thread(target=self._run, name=f"{PLUGIN_NAME}:listener", daemon=True).start()
        threading.Thread(target=self._ticker, name=f"{PLUGIN_NAME}:reinject", daemon=True).start()
        return True

    def _ensure_state(self) -> None:
        """Load persisted state once (callers hold the lock)."""
        if self._store is None:
            self._store = StateStore(self._data_dir())
            self._state = self._store.load()

    def _retire(self) -> None:
        """Stop all wake activity: no queued, pending or repeat wake may follow."""
        self._stopping.set()
        with self._lock:
            if self._flush_timer is not None:
                self._flush_timer.cancel()
                self._flush_timer = None
            self._pending.clear()

    def shutdown(self, timeout: float = 5.0) -> None:
        self._retire()
        with self._lock:
            child = self._child
        if child is not None and child.poll() is None:
            try:
                child.terminate()
                child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                child.kill()
            except OSError:
                pass

    def _run(self) -> None:
        delay = self._backoff_start_s
        while not self._stopping.is_set():
            code, stop_reason, refused = self._run_once()
            if self._stopping.is_set():
                break
            action = exit_action(code, stop_reason)
            if self._listening:
                delay = self._backoff_start_s  # a listener that got going resets the backoff
            if action == "stop":
                # A terminal stop (evicted, rebound, revoked, trust changed, binding refused) ends every
                # wake for this binding, not only the listener: retire timers and pending repeats first.
                self._retire()
                self.final_action = "stop"
                if code != 0:
                    logger.warning("%s: listener stopped (exit %s, %s); not restarting until the gateway restarts",
                                   PLUGIN_NAME, code, stop_reason or (refused or {}).get("code") or "no reason")
                return
            if action == "owned" and self._reap((refused or {}).get("owner_pid")):
                delay = self._backoff_start_s
            if self._stopping.wait(delay):
                break
            delay = min(delay * 2, self._backoff_cap_s)

    def _run_once(self) -> tuple[Optional[int], Optional[str], Optional[dict]]:
        s = self.settings
        args = [s.borg_command, "representative", "listen", "--worktree", s.worktree]
        with self._lock:
            through = (self._state.get("delivered") or {}).get("entry_id")
        if isinstance(through, str) and _UUID.match(through):
            args += ["--replay-after", through]
        self._listening = False
        errors = self._stderr_log()
        try:
            child = self._popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors,
                                text=True, bufsize=1, close_fds=True)
        except OSError as error:
            logger.warning("%s: cannot start %s: %s", PLUGIN_NAME, s.borg_command, error)
            return 1, None, None
        finally:
            if errors not in (None, subprocess.DEVNULL):
                errors.close()
        info = self._info(child.pid)
        with self._lock:
            self._child = child
            # Recorded as the lease holder only once it reports `listening`: a child refused
            # with exit 3 must not overwrite the record of the orphan it was refused by.
            self._spawned = {"pid": child.pid, "parent": os.getpid(), "started": info[1] if info else None}
            if self._stopping.is_set():
                child.terminate()  # shutdown raced this spawn: do not leave a child behind
        stop_reason: Optional[str] = None
        refused: Optional[dict] = None
        for line in child.stdout:
            event = self._parse(line)
            if event is None:
                continue
            kind = event.get("event")
            if kind == "stopped":
                stop_reason = event.get("reason") if isinstance(event.get("reason"), str) else None
            elif kind == "refused":
                refused = event
            self.handle_event(event)
        code = child.wait()
        child.stdout.close()
        with self._lock:
            self._child = None
        return code, stop_reason, refused

    def _stderr_log(self) -> Any:
        """Listener diagnostics go to a private, size-capped file, never to the prompt."""
        with self._lock:
            store = self._store
        if store is None:
            return subprocess.DEVNULL
        path = store.path.with_name("listener.stderr.log")
        try:
            mode = "w" if path.exists() and path.stat().st_size > 1_000_000 else "a"
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if mode == "w" else os.O_APPEND), 0o600)
            return os.fdopen(descriptor, mode, encoding="utf-8")
        except OSError:
            return subprocess.DEVNULL

    @staticmethod
    def _parse(line: str) -> Optional[dict]:
        try:
            event = json.loads(line)
        except ValueError:
            return None
        return event if isinstance(event, dict) else None

    # ---- hints and injection ---------------------------------------------------------

    def handle_event(self, event: dict) -> None:
        kind = event.get("event")
        if kind == "listening":
            self._listening = True
            with self._lock:
                if self._spawned is not None:
                    self._state["child"] = self._spawned
                    self._save()
            logger.info("%s: listening (binding %s)", PLUGIN_NAME, event.get("binding_fingerprint"))
        elif kind == "entry":
            self._hint(event.get("entry_id"), event.get("created_at"))
        elif kind == "gap":
            self._hint("gap", None)
        # Unknown events and fields are ignored by contract.

    def _hint(self, key: Any, created_at: Any) -> None:
        with self._lock:
            if self._stopping.is_set():
                return
            self._ensure_state()
            if key != "gap":
                point = _point(key, created_at)
                if point is None:
                    return
                key = point[1]
                delivered = self._delivered_point()
                if delivered is not None and point <= delivered:
                    return  # already delivered; a replayed hint needs no wake
            else:
                point = None
            if key in self._pending:
                return
            used = self._wakes_used(key)
            if used > self.settings.max_reinjects:
                return  # budget spent (possibly before a restart): no wake until a delivery covers it
            # A reply already woken before a restart waits reinject_after_s for its next wake.
            self._pending[key] = {"point": point, "created_at": created_at, "count": used,
                                  "last": self._clock() if used else None}
            if not used:
                self._schedule_flush(self._debounce_s)

    def _wake_records(self) -> dict:
        records = self._state.get("wakes")
        return records if isinstance(records, dict) else {}

    def _wakes_used(self, key: str) -> int:
        """Persisted wakes already spent on this reply (or on the gap) since its last delivery."""
        if key == "gap":
            used = self._state.get("gap_wakes", 0)
        else:
            used = (self._wake_records().get(key) or {}).get("count", 0)
        return used if isinstance(used, int) and not isinstance(used, bool) and used > 0 else 0

    def _record_wakes(self, keys: list[str], delta: int) -> None:
        """Write-through wake counts. Records are removed only by an observed delivery."""
        records = dict(self._wake_records())
        for key in keys:
            item = self._pending.get(key)
            if item is None:
                continue
            item["count"] = max(0, item["count"] + delta)
            if key == "gap":
                self._state["gap_wakes"] = item["count"]
            elif item["count"]:
                records[key] = {"created_at": item["created_at"], "count": item["count"]}
            else:
                records.pop(key, None)
        self._state["wakes"] = records
        self._save()

    def _schedule_flush(self, delay: float) -> None:
        if self._stopping.is_set() or (self._flush_timer is not None and self._flush_timer.is_alive()):
            return
        timer = threading.Timer(delay, self.flush)
        timer.daemon = True
        self._flush_timer = timer
        timer.start()

    def flush(self) -> None:
        """Wake once for every hint not yet injected (debounced burst coalescing)."""
        with self._lock:
            self._flush_timer = None
            if self._stopping.is_set():
                return
            fresh = [key for key, item in self._pending.items() if item["count"] == 0]
        if fresh:
            self._wake(fresh)

    def tick(self) -> None:
        """Re-inject net: wake again for hints still undelivered after reinject_after_s."""
        now = self._clock()
        with self._lock:
            if self._stopping.is_set():
                return
            due: list[str] = []
            for key, item in list(self._pending.items()):
                if item["count"] == 0 or now - item["last"] < self.settings.reinject_after_s:
                    continue
                if item["count"] > self.settings.max_reinjects:
                    logger.warning("%s: a Coordinator reply is still undelivered after %d wakes; giving up on it "
                                   "until it is delivered", PLUGIN_NAME, item["count"])
                    del self._pending[key]  # its persisted record keeps the budget spent
                    continue
                due.append(key)
        if due:
            self._wake(due)

    def _wake(self, keys: list[str]) -> None:
        with self._lock:
            if self._stopping.is_set():
                return
            keys = [key for key in keys if key in self._pending]
            if not keys:
                return
            # Count the wake on disk before Hermes can start the turn: a restart at any point after
            # this can never renew the budget. A crash between here and the call loses one wake at
            # most; it never adds one.
            self._record_wakes(keys, +1)
        try:
            accepted = bool(self._inject(WAKE_TEXT))
        except Exception:  # the host API must never take the supervisor down
            logger.warning("%s: inject_message raised", PLUGIN_NAME, exc_info=True)
            accepted = False
        now = self._clock()
        with self._lock:
            if not accepted:
                self._record_wakes(keys, -1)  # Hermes refused it: nothing was spent
                self._inject_failures += 1
                if self._inject_failures == 1 or self._inject_failures % 10 == 0:
                    logger.warning("%s: Hermes did not accept the wake (%d failures); check allow_gateway_injection "
                                   "and settings.session_key", PLUGIN_NAME, self._inject_failures)
                self._schedule_flush(self._retry_s)
                return
            self._inject_failures = 0
            self.injections += 1
            for key in keys:
                item = self._pending.get(key)
                if item is not None:
                    item["last"] = now

    def _ticker(self) -> None:
        while not self._stopping.wait(self._tick_s):
            try:
                self.tick()
            except Exception:
                logger.warning("%s: re-inject check failed", PLUGIN_NAME, exc_info=True)

    # ---- delivery observation -------------------------------------------------------

    def _delivered_point(self) -> Optional[tuple[datetime, str]]:
        delivered = self._state.get("delivered") or {}
        return _point(delivered.get("entry_id"), delivered.get("created_at"))

    def observe_delivered(self, checkpoint: dict) -> None:
        """A deliver call in this gateway moved (or confirmed) the delivered checkpoint."""
        point = _point(checkpoint.get("entry_id"), checkpoint.get("created_at"))
        if point is None:
            return
        with self._lock:
            self._ensure_state()
            changed = False
            current = self._delivered_point()
            if current is None or point > current:
                self._state["delivered"] = {"entry_id": checkpoint["entry_id"], "created_at": checkpoint["created_at"]}
                changed = True
            records = self._wake_records()
            remaining = {}
            for k, v in records.items():
                woken = _point(k, (v or {}).get("created_at") if isinstance(v, dict) else None)
                if woken is None or woken > point:
                    remaining[k] = v  # not covered by this delivery
            if remaining != records:
                self._state["wakes"] = remaining
                changed = True
            if self._state.get("gap_wakes"):
                self._state["gap_wakes"] = 0  # the conversation has read since the gap
                changed = True
            if changed:
                self._save()
            self._pending.pop("gap", None)  # the conversation has read since the gap
            for key, item in list(self._pending.items()):
                if item["point"] is not None and item["point"] <= point:
                    del self._pending[key]

    def pending(self) -> dict[str, dict]:
        with self._lock:
            return {key: dict(item) for key, item in self._pending.items()}

    def _save(self) -> None:
        if self._store is None:
            return
        try:
            self._store.save(self._state)
        except OSError:
            logger.warning("%s: cannot write plugin state", PLUGIN_NAME, exc_info=True)

    # ---- orphan reaping -------------------------------------------------------------

    def _reap(self, owner_pid: Any) -> bool:
        """SIGTERM a previous listener only if it is the recorded child and was orphaned."""
        with self._lock:
            recorded = dict(self._state.get("child") or {})
        if isinstance(owner_pid, bool) or not isinstance(owner_pid, int) or owner_pid != recorded.get("pid"):
            return False
        info = self._info(owner_pid)
        if info is None:
            return False
        ppid, started, command = info
        if not recorded.get("started") or started != recorded["started"]:
            return False  # the pid was reused by another process
        if ppid == recorded.get("parent") or ppid == os.getpid():
            return False  # its parent is alive: not an orphan
        if "representative" not in command or "listen" not in command:
            return False
        try:
            self._kill(owner_pid, signal.SIGTERM)
        except OSError:
            return False
        logger.info("%s: stopped orphaned listener pid %d from a previous gateway", PLUGIN_NAME, owner_pid)
        return True


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


def _post_tool_call_observer(expected_tool: str) -> Callable[..., None]:
    def on_post_tool_call(tool_name: Any = None, result: Any = None, **kwargs: Any) -> None:
        del kwargs
        if tool_name != expected_tool:
            return
        with _SUPERVISOR_LOCK:
            supervisor = _SUPERVISOR
        if supervisor is None:
            return  # not the gateway process
        checkpoint = parse_delivered(result)
        if checkpoint is not None:
            supervisor.observe_delivered(checkpoint)

    return on_post_tool_call


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
    ctx.register_hook("post_tool_call", _post_tool_call_observer(deliver_tool_name(settings.mcp_server)))
    atexit.register(_shutdown)
