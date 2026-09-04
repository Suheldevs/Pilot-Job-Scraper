"""Shared source interface + a retrying, cache-aware fetch helper.

Design rule: a source must never raise out of collect() — one blocked
or broken site should not take down the run. Each source logs its own
failures and returns whatever it managed to get, even if that's nothing.

Every source gets three things for free by subclassing:
  - retries with exponential backoff, and `Retry-After` honoured when sent
  - conditional requests (If-Modified-Since / If-None-Match) so a re-poll of
    unchanged data costs a 304 instead of the full body
  - a persisted circuit breaker, so a source that is refusing us stays skipped
    across runs instead of being re-hammered every 6 hours
"""
from abc import ABC, abstractmethod
import json
import time
from typing import Any, List

import httpx

import config
from http_cache import HttpState
from models import Job


class Source(ABC):
    name: str = "base"

    # Statuses that mean "blocked", not "transient" — retrying won't change
    # the outcome, it just hammers a site that's already refusing us.
    _NON_RETRYABLE = (401, 403, 406)

    # Shared across every source in a run so one JSON file holds all state.
    _state: HttpState | None = None

    @classmethod
    def state(cls) -> HttpState:
        if Source._state is None:
            Source._state = HttpState()
        return Source._state

    def collect(self) -> List[Job]:
        state = self.state()
        allowed, why = state.can_request(self.name)
        if not allowed:
            print(f"[{self.name}] skipped — {why}")
            return []

        try:
            jobs = self._collect_impl()
        except Exception as e:
            print(f"[{self.name}] FAILED: {e}")
            state.record_failure(self.name)
            state.save()
            return []

        # An empty result isn't necessarily a failure (a filter may have
        # matched nothing), so only the explicit failure paths trip the
        # breaker — see _fetch.
        state.save()
        print(f"[{self.name}] collected {len(jobs)} jobs")
        return jobs

    @abstractmethod
    def _collect_impl(self) -> List[Job]:
        ...

    def _fetch(self, client: httpx.Client, url: str, conditional: bool = False,
               **kwargs) -> httpx.Response | None:
        """GET with retries and backoff. Returns None on failure.

        With `conditional=True`, stored validators are sent and a `304` comes
        back as None — meaning "nothing changed", which a caller should treat
        as no new data rather than as an error.
        """
        state = self.state()

        if conditional:
            headers = dict(kwargs.pop("headers", {}) or {})
            headers.update(state.conditional_headers(url))
            if headers:
                kwargs["headers"] = headers

        for attempt in range(1, config.MAX_RETRIES + 1):
            try:
                resp = client.get(url, timeout=config.REQUEST_TIMEOUT, **kwargs)

                if resp.status_code == 200:
                    state.record_success(self.name)
                    if conditional:
                        state.remember(url, resp)
                    return resp

                if resp.status_code == 304:
                    print(f"[{self.name}] 304 unchanged: {url[:80]}")
                    state.record_success(self.name)
                    return None

                if resp.status_code in self._NON_RETRYABLE:
                    print(f"[{self.name}] HTTP {resp.status_code} — blocked "
                          f"(not retrying): {url[:100]}")
                    state.record_failure(self.name)
                    return None

                # 429/503 often carry Retry-After; obeying it is both politer
                # and more effective than our own guessed curve.
                wait = self._retry_after(resp)
                print(f"[{self.name}] HTTP {resp.status_code} on attempt {attempt}: {url[:100]}"
                      + (f" (Retry-After {wait}s)" if wait else ""))
                if resp.status_code in (429, 503):
                    state.record_failure(self.name)
                if attempt < config.MAX_RETRIES:
                    time.sleep(wait if wait else config.RETRY_BASE_DELAY * (2 ** (attempt - 1)))
                continue

            except httpx.RequestError as e:
                print(f"[{self.name}] request error on attempt {attempt}: {e}")

            if attempt < config.MAX_RETRIES:
                time.sleep(config.RETRY_BASE_DELAY * (2 ** (attempt - 1)))

        state.record_failure(self.name)
        return None

    @staticmethod
    def _retry_after(resp: httpx.Response) -> int:
        """Seconds from a Retry-After header, capped so we never sleep absurdly."""
        raw = resp.headers.get("retry-after")
        if not raw:
            return 0
        try:
            return max(0, min(120, int(float(raw))))
        except ValueError:
            return 0  # HTTP-date form; not worth parsing for our purposes

    def _pace(self) -> None:
        time.sleep(config.DELAY_BETWEEN_REQUESTS)

    @staticmethod
    def _json(resp: httpx.Response) -> Any:
        """Parse JSON, forcing UTF-8.

        Several of these APIs return JSON without a charset in Content-Type.
        httpx then falls back to a guess, which decodes UTF-8 bytes as latin-1
        and turns a curly apostrophe into "â€™" inside company names — the
        mangled text then gets stored and shown in the dashboard.
        """
        return json.loads(resp.content.decode("utf-8", errors="replace"))
