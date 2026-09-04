"""MX validation — a gate on every address the extractor produces.

Why this and not the usual pattern-guessing: guessing `jobs@{company}.com` and
stamping it "confidence 0.7" produces addresses that look plausible and bounce.
An address is only worth keeping if the domain can actually receive mail, so we
check for an MX record — not an A record. A parked domain with a webserver and
no mail has an A record and passes that weaker test, which is exactly the false
positive we want to avoid.

Fail-open on transient DNS: a timeout means we don't know, so we keep the
address and deliberately don't cache the verdict. Only NXDOMAIN and a
no-MX-answer are treated as real rejections.
"""
from typing import Dict, List, Set, Tuple

try:
    import dns.resolver
    _DNS_AVAILABLE = True
except ImportError:  # the gate degrades to a pass-through, never a crash
    _DNS_AVAILABLE = False

_valid: Set[str] = set()
_invalid: Set[str] = set()

_resolver = None


def _get_resolver():
    global _resolver
    if _resolver is None and _DNS_AVAILABLE:
        _resolver = dns.resolver.Resolver()
        _resolver.timeout = 3.0
        _resolver.lifetime = 5.0
    return _resolver


def domain_of(email: str) -> str:
    return email.rsplit("@", 1)[-1].strip().lower() if "@" in email else ""


def has_mx(domain: str) -> bool:
    """True if the domain can receive mail. Unknown counts as True."""
    if not domain:
        return False
    if domain in _valid:
        return True
    if domain in _invalid:
        return False
    if not _DNS_AVAILABLE:
        return True  # no resolver installed — don't silently drop everything

    resolver = _get_resolver()
    try:
        answers = resolver.resolve(domain, "MX")
        if len(answers):
            _valid.add(domain)
            return True
        _invalid.add(domain)
        return False
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        # Definitive: the domain doesn't exist, or has no mail exchanger.
        _invalid.add(domain)
        return False
    except Exception:
        # Timeout, SERVFAIL, no nameservers reachable — we genuinely don't
        # know. Keep the address and don't poison the cache with a guess.
        return True


def filter_emails(emails: List[str]) -> Tuple[List[str], List[str]]:
    """Split addresses into (deliverable, rejected)."""
    keep, drop = [], []
    for email in emails:
        (keep if has_mx(domain_of(email)) else drop).append(email)
    return keep, drop


def stats() -> Dict[str, int]:
    return {"domains_ok": len(_valid), "domains_rejected": len(_invalid)}
