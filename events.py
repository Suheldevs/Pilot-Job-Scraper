"""Run log recorder for the scraper.

The scraper runs unattended every 6 hours, so when a source breaks nobody
finds out until they read scrape.log on the machine that ran it. A `Recorder`
collects one event per interesting step — each source, each pipeline layer,
the push, the prune — and ships them to /api/events at the end of the run so
the failure is visible in the dashboard instead.

Design rule, same as sources/base.py: this must never affect a scrape. It is
observability, and a run that succeeded must not be reported as failed (or
worse, crash) because the log couldn't be written. Every method swallows its
own errors; the one exception is `timed`, which re-raises the block's
exception after recording it so the caller still decides what to do with it.

Usage:
    rec = events.Recorder()
    rec.start()
    with rec.timed("source", "keka"):
        jobs = KekaSource(slugs).collect()
    rec.layer("relevance", "ok", {"kept": len(jobs)})
    rec.end("ok")
    rec.flush(client, base_url)      # client already logged in — push.py::login
    print(rec.summary())
"""
import random
import time
from contextlib import contextmanager
from typing import Dict, List, Optional

KINDS = ("run_start", "run_end", "source", "layer", "push", "prune", "error")
STATUSES = ("ok", "fail", "skip", "partial")

# A pathological run — a source looping over thousands of slugs, say — must not
# grow this list without bound, so events past the cap are dropped and counted.
MAX_EVENTS = 500

# Short, because this fires at the very end of a run: a hung dashboard should
# cost seconds, not hold the process open for a minute.
REQUEST_TIMEOUT = 20.0

_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"


def _run_id() -> str:
    """Timestamp plus a short random suffix.

    The timestamp makes runs sort and read naturally; the suffix keeps two runs
    started in the same second (a manual run overlapping the scheduled one)
    from being merged into a single run in the dashboard.
    """
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    suffix = "".join(random.choice(_SUFFIX_ALPHABET) for _ in range(4))
    return f"{stamp}-{suffix}"


class Recorder:
    """In-memory buffer of run events, flushed once at the end of a run."""

    def __init__(self) -> None:
        self.run_id = _run_id()
        self.events: List[dict] = []
        self.dropped = 0          # events refused by the MAX_EVENTS cap
        self.started_at: Optional[int] = None

    # ---- recording -------------------------------------------------------
    def _add(self, kind: str, name: str, status: str,
             counts: Optional[Dict[str, int]] = None, message: str = "",
             duration_ms: Optional[int] = None) -> None:
        """Append one event. Never raises — see the module docstring."""
        try:
            if len(self.events) >= MAX_EVENTS:
                self.dropped += 1
                return
            self.events.append({
                "at": int(time.time() * 1000),
                "kind": kind if kind in KINDS else "error",
                "name": str(name or "")[:80],
                "status": status if status in STATUSES else "fail",
                "message": str(message or "")[:500],
                "counts": {k: v for k, v in (counts or {}).items()},
                "duration_ms": int(duration_ms) if duration_ms is not None else None,
            })
        except Exception:
            pass

    def start(self) -> None:
        self.started_at = int(time.time() * 1000)
        self._add("run_start", "", "ok")

    def end(self, status: str, message: str = "",
            counts: Optional[Dict[str, int]] = None) -> None:
        """Close the run. A missing run_end is how the API spots a crashed run,
        so this should be reached on the error path too."""
        duration = None
        if self.started_at is not None:
            duration = int(time.time() * 1000) - self.started_at
        self._add("run_end", "", status, counts, message, duration)

    def source(self, name: str, status: str, counts: Optional[Dict[str, int]] = None,
               message: str = "", duration_ms: Optional[int] = None) -> None:
        self._add("source", name, status, counts, message, duration_ms)

    def layer(self, name: str, status: str, counts: Optional[Dict[str, int]] = None,
              message: str = "", duration_ms: Optional[int] = None) -> None:
        self._add("layer", name, status, counts, message, duration_ms)

    def push(self, status: str, counts: Optional[Dict[str, int]] = None,
             message: str = "", duration_ms: Optional[int] = None) -> None:
        self._add("push", "push", status, counts, message, duration_ms)

    def prune(self, status: str, counts: Optional[Dict[str, int]] = None,
              message: str = "") -> None:
        self._add("prune", "prune", status, counts, message)

    def error(self, name: str, message: str) -> None:
        self._add("error", name, "fail", None, message)

    @contextmanager
    def timed(self, kind: str, name: str):
        """Record `kind`/`name` with its wall time, and its exception if it raised.

        The exception is re-raised: a source that swallows its own failures
        (sources/base.py) will never get here, so anything that does reach this
        handler is a real error the caller has to decide about. Recording it
        must not also decide to hide it.
        """
        began = time.time()
        try:
            yield
        except Exception as e:
            elapsed = int((time.time() - began) * 1000)
            self._add(kind, name, "fail", None, f"{type(e).__name__}: {e}", elapsed)
            raise
        else:
            elapsed = int((time.time() - began) * 1000)
            self._add(kind, name, "ok", None, "", elapsed)

    # ---- output ----------------------------------------------------------
    def flush(self, client, base_url: str) -> bool:
        """POST the buffer to /api/events. Returns True on success.

        `client` must be an httpx.Client that has already logged in — the
        session cookie is armed by push.py::login. Any failure here is printed
        and swallowed: losing the log is not worth failing a good scrape over.
        """
        try:
            if not self.events:
                return True
            resp = client.post(
                f"{base_url.rstrip('/')}/api/events",
                json={"run_id": self.run_id, "events": self.events},
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code != 200:
                print(f"Run log not saved — HTTP {resp.status_code} from /api/events")
                return False
            # Drop the buffer only once the server has it, so a retry after a
            # failed flush still has everything and a second flush can't
            # double-post the same run.
            self.events = []
            return True
        except Exception as e:
            print(f"Run log not saved — {type(e).__name__}: {e}")
            return False

    def summary(self) -> str:
        """One line describing the run, for printing when it finishes."""
        try:
            by_status: Dict[str, int] = {}
            failures: List[str] = []
            for e in self.events:
                by_status[e["status"]] = by_status.get(e["status"], 0) + 1
                if e["status"] == "fail":
                    label = e["name"] or e["kind"]
                    failures.append(f"{label} ({e['message']})" if e["message"] else label)

            parts = [f"run {self.run_id}", f"{len(self.events)} events"]
            counted = ", ".join(f"{s}:{by_status[s]}" for s in STATUSES if s in by_status)
            if counted:
                parts.append(counted)
            if self.started_at is not None:
                parts.append(f"{(int(time.time() * 1000) - self.started_at) / 1000:.1f}s")
            if self.dropped:
                parts.append(f"{self.dropped} events dropped (buffer cap {MAX_EVENTS})")
            line = " — ".join(parts)
            if failures:
                line += "\n  failed: " + "; ".join(failures[:10])
            return line
        except Exception as e:
            # Even the summary is non-fatal — it is the last thing a run prints.
            return f"run {self.run_id} — summary unavailable ({e})"
