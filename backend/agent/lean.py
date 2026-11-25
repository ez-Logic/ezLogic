"""Lean verification.

Everything runs in one lean-interact REPL, started lazily and reused, on top of an
environment with Mathlib already imported:
  * check_file    - reads a .lean file from the workspace and checks its contents.
                    Best for full proofs. Only Mathlib/Std/Lean/Batteries imports are
                    supported, since those are what the preloaded environment has.
  * check_snippet - checks a short code snippet. Best for quick experiments.
"""

import asyncio
import logging
import re
import shutil
import threading
import time
from dataclasses import asdict, dataclass, field
from hashlib import sha256

from config import Config

from .workspace import Workspace

log = logging.getLogger(__name__)


@dataclass
class LeanResult:
    ok: bool  # True when Lean reports no errors
    messages: list[dict] = field(default_factory=list)
    output: str = ""
    error: str | None = None  # tooling failure (Lean missing, timeout, ...)
    proof_candidate: bool | None = None
    source_hash: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


LEAN_MISSING = (
    "Lean is not installed or not on PATH. Install it with elan: "
    "https://lean-lang.org/lean4/doc/setup.html"
)


# --- lean-interact REPL -----------------------------------------------------------
#
# The REPL process and the "Mathlib already imported" environment it builds are both
# reused across every Lean check (and across requests/users): building
# them is slow -- starting the REPL and loading Mathlib the first time can take a
# minute or more -- but once done, a snippet that reuses that environment typically
# checks in well under a second instead of ~40s for a fresh `import Mathlib`.

_server = None
_server_lock = threading.Lock()

_mathlib_env: int | None = None
_env_lock = threading.Lock()
_operation_lock = threading.RLock()


def _is_lake_project() -> bool:
    root = Config.WORKSPACE_DIR
    return any((root / f).exists() for f in ("lakefile.lean", "lakefile.toml"))


def _repl_source(lean_version: str | None) -> dict:
    """`repl_git`/`repl_rev` kwargs for LeanREPLConfig.

    The official leanprover-community/repl tags every Lean release with the bare
    version (`v4.37.0-rc1`). lean-interact first tries `{rev}_lean-toolchain-{ver}`
    (its fork's tag scheme), and when that doesn't exist falls back to checking
    out `{rev}` itself -- so passing the version as the rev picks the right tag.
    Returns {} (lean-interact's defaults) when there's no version to pin to.
    """
    rev = Config.LEAN_REPL_REV or lean_version
    if not rev:
        return {}
    return {"repl_git": Config.LEAN_REPL_GIT, "repl_rev": rev}


def _get_server():
    """Start (once) and return a lean-interact REPL server. Blocking."""
    global _server
    with _server_lock:
        if _server is None:
            from lean_interact import AutoLeanServer, LeanREPLConfig, LocalProject
            from lean_interact.utils import get_project_lean_version

            root = Config.WORKSPACE_DIR
            if _is_lake_project():
                # Run snippets inside the workspace's Lake project so they get the same
                # toolchain and Mathlib as check_file. lean-interact reads the Lean
                # version from the project and rejects an explicit lean_version.
                repl_config = LeanREPLConfig(
                    project=LocalProject(
                        directory=str(root), lake_path=Config.LAKE_PATH
                    ),
                    cache_dir=Config.LEAN_INTERACT_CACHE,
                    lake_path=Config.LAKE_PATH,
                    **_repl_source(get_project_lean_version(root)),
                )
            else:
                repl_config = LeanREPLConfig(
                    lean_version=Config.LEAN_VERSION,
                    cache_dir=Config.LEAN_INTERACT_CACHE,
                    lake_path=Config.LAKE_PATH,
                    **_repl_source(Config.LEAN_VERSION),
                )
            log.info(
                "starting lean-interact REPL (first use; building/downloading can take a while)"
            )
            t0 = time.monotonic()
            _server = AutoLeanServer(
                repl_config, max_total_memory=Config.LEAN_MAX_TOTAL_MEMORY
            )
            log.info("lean-interact REPL ready in %.1fs", time.monotonic() - t0)
        return _server


def _get_base_env(server) -> int | None:
    """Environment id with Mathlib already imported, built once and reused. `None`
    when the workspace isn't a Lake project (no Mathlib available to preload)."""
    global _mathlib_env
    if not _is_lake_project():
        return None
    with _env_lock:
        if _mathlib_env is None:
            from lean_interact import Command
            from lean_interact.interface import LeanError

            log.info(
                "loading Mathlib into the REPL (first snippet check; can take ~30-60s)"
            )
            t0 = time.monotonic()
            response = server.run(
                Command(cmd="import Mathlib\nimport Lean"),
                timeout=Config.LEAN_STARTUP_TIMEOUT,
                add_to_session_cache=True,
            )
            if isinstance(response, LeanError):
                raise RuntimeError(
                    f"Failed to load Mathlib into the REPL: {response.message}"
                )
            _mathlib_env = response.env
            log.info(
                "Mathlib loaded in %.1fs (env=%s)", time.monotonic() - t0, _mathlib_env
            )
        return _mathlib_env


_IMPORT_LINE = re.compile(r"^[ \t]*import\s+\S.*$", re.MULTILINE)


def _without_imports(code: str) -> str:
    """Blank out every `import ...` line, wherever it appears.

    Once a command runs inside an existing environment (`env=...`), Lean rejects an
    `import` anywhere in it, even after a comment -- not just outside a leading
    block (https://github.com/augustepoiroux/LeanInteract: "invalid 'import'
    command, it must be used in the beginning of the file"). The snippet already
    has Mathlib via that environment, so the model's own import line (if it wrote
    one, as the system prompt tells it to for files) is redundant anyway.

    Each import line is replaced with an empty line, rather than removed, so every
    other line keeps its original line number -- Lean's error messages (and the
    step's own logged `target=`) still point at the line the model actually wrote.
    """
    return _IMPORT_LINE.sub("", code)


# Modules `import Mathlib` already brings into the preloaded REPL environment.
_SUPPORTED_IMPORT_ROOTS = ("Mathlib", "Std", "Lean", "Batteries", "Init")
_IMPORT_NAMES = re.compile(r"^[ \t]*import\s+(.+)$", re.MULTILINE)
_BLOCK_COMMENT = re.compile(r"/-.*?-/", re.DOTALL)
_LINE_COMMENT = re.compile(r"--.*$", re.MULTILINE)

_SOURCE_TOKEN = re.compile(r'--[^\n]*|/-|"(?:\\.|[^"\\])*"', re.DOTALL)
_COMMENT_DELIMITER = re.compile(r"/-|-/")
_PROOF_DECLARATION = re.compile(
    r"^[ \t]*(?:@\[[^\]]*\]\s*|(?:public|private|protected|noncomputable)\s+)*"
    r"(?:theorem|lemma|example)\s+",
    re.MULTILINE,
)


def is_proof_candidate(code: str) -> bool:
    """Recognize declaration attempts even when Lean later rejects their syntax."""
    spans = []
    offset = 0
    while token := _SOURCE_TOKEN.search(code, offset):
        spans.append(code[offset : token.start()])
        offset = token.end()
        if token.group() == "/-":
            depth = 1
            for delimiter in _COMMENT_DELIMITER.finditer(code, offset):
                depth += 1 if delimiter.group() == "/-" else -1
                if depth == 0:
                    offset = delimiter.end()
                    break
            else:
                offset = len(code)
        spans.append(re.sub(r"[^\n]", " ", code[token.start() : offset]))
    spans.append(code[offset:])
    return bool(_PROOF_DECLARATION.search("".join(spans)))


def source_hash(code: str) -> str:
    return sha256(code.encode("utf-8")).hexdigest()


def _unsupported_imports(code: str) -> list[str]:
    """Imported modules the preloaded environment doesn't provide (anything outside
    Mathlib/Std/Lean/Batteries/Init), in order of appearance, without duplicates.
    Imports inside comments are ignored."""
    stripped = _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", code))
    found: list[str] = []
    for match in _IMPORT_NAMES.finditer(stripped):
        for module in match.group(1).split():
            if (
                module.split(".")[0] not in _SUPPORTED_IMPORT_ROOTS
                and module not in found
            ):
                found.append(module)
    return found


def _run_in_repl(code: str, label: str) -> LeanResult:
    with _operation_lock:
        return _run_in_repl_locked(code, label)


def _run_in_repl_locked(code: str, label: str) -> LeanResult:
    """Check `code` in the shared REPL on top of the Mathlib environment. Blocking.
    `label` names the caller in logs (`check_lean_snippet`, `check_lean_file path=...`)."""
    from lean_interact import Command
    from lean_interact.interface import LeanError

    if not shutil.which(Config.LAKE_PATH):
        return LeanResult(ok=False, error=LEAN_MISSING)

    t0 = time.monotonic()
    try:
        server = _get_server()
        base_env = _get_base_env(
            server
        )  # may legitimately take ~30-60s on the very first call
        body = _without_imports(code) if base_env is not None else code
        t_run = time.monotonic()
        response = server.run(
            Command(cmd=body, env=base_env), timeout=Config.LEAN_TIMEOUT
        )
        run_elapsed = time.monotonic() - t_run
    except Exception as e:  # REPL build/startup failures, timeouts, ...
        log.warning(
            "%s failed after %.1fs: %s: %s",
            label,
            time.monotonic() - t0,
            type(e).__name__,
            e,
        )
        return LeanResult(ok=False, error=f"{type(e).__name__}: {e}")

    if isinstance(response, LeanError):
        log.info(
            "%s rejected after %.1fs: %s",
            label,
            time.monotonic() - t0,
            response.message,
        )
        return LeanResult(ok=False, error=response.message)

    messages = [
        {
            "severity": m.severity,
            "line": m.start_pos.line if m.start_pos else None,
            "column": m.start_pos.column if m.start_pos else None,
            "message": m.data,
        }
        for m in response.messages
    ]
    # Count `sorry` as not proven.
    for s in response.sorries:
        messages.append(
            {
                "severity": "warning",
                "line": s.start_pos.line if s.start_pos else None,
                "column": s.start_pos.column if s.start_pos else None,
                "message": f"unsolved goal (sorry): {s.goal}",
            }
        )
    ok = not response.has_errors() and not response.sorries
    if base_env is not None and run_elapsed > 10:
        # Mathlib was supposedly already loaded by _get_base_env (that cost is
        # deliberately excluded from run_elapsed), so running one small snippet
        # against it should take well under a second. This long instead almost
        # always means lean-interact silently killed and restarted the Lean process
        # (its AutoLeanServer does this on its own, see Config.LEAN_MAX_TOTAL_MEMORY)
        # and had to replay the cached environment from scratch -- i.e. re-import
        # Mathlib -- before it could run this snippet.
        log.warning(
            "%s: Lean call took %.1fs despite reusing a loaded "
            "environment; the Lean REPL likely restarted under memory pressure and "
            "replayed Mathlib from scratch (see LEAN_MAX_TOTAL_MEMORY in backend/.env.example)",
            label,
            run_elapsed,
        )
    log.info("%s done ok=%s elapsed=%.1fs", label, ok, time.monotonic() - t0)
    return LeanResult(ok=ok, messages=messages)


async def _check(code: str, label: str) -> LeanResult:
    try:
        # The inner lean-interact `timeout=` (LEAN_TIMEOUT, in _run_in_repl) covers
        # the normal per-check case once the REPL is warm. This outer bound is just a
        # safety net for the rare case of the REPL/Mathlib build itself hanging,
        # which isn't covered by that inner timeout.
        result = await asyncio.wait_for(
            asyncio.to_thread(_run_in_repl, code, label),
            timeout=Config.LEAN_STARTUP_TIMEOUT,
        )
    except asyncio.TimeoutError:
        log.warning(
            "%s exceeded the %.0fs safety timeout", label, Config.LEAN_STARTUP_TIMEOUT
        )
        result = LeanResult(
            ok=False,
            error=f"Lean check timed out after {Config.LEAN_STARTUP_TIMEOUT:.0f}s",
        )
    result.proof_candidate = is_proof_candidate(code)
    result.source_hash = source_hash(code)
    return result


async def check_snippet(code: str) -> LeanResult:
    return await _check(code, "check_lean_snippet")


async def check_file(workspace: Workspace, path: str) -> LeanResult:
    """Check a workspace .lean file's contents in the REPL."""
    target = workspace.resolve(path)
    if not target.is_file():
        return LeanResult(ok=False, error=f"No such file: {path}")
    code = target.read_text(encoding="utf-8", errors="replace")
    if unsupported := _unsupported_imports(code):
        return LeanResult(
            ok=False,
            proof_candidate=is_proof_candidate(code),
            source_hash=source_hash(code),
            error=(
                "check_lean_file only supports imports from Mathlib, Std, Lean and "
                f"Batteries (already loaded); found: {', '.join(unsupported)}"
            ),
        )
    return await _check(code, f"check_lean_file path={path}")


async def warm_up() -> None:
    """Best-effort: start the REPL and preload Mathlib ahead of the first real
    request, instead of making whoever sends the first message pay for it. Safe to
    call even when Lean/Lake aren't installed, or the workspace isn't a Lake
    project -- it just does nothing in those cases. Failures aren't fatal: the next
    Lean check will simply try again (and report any error normally)."""
    if not shutil.which(Config.LAKE_PATH):
        return

    def start():
        with _operation_lock:
            _get_base_env(_get_server())

    await asyncio.to_thread(start)
