"""Classify a free-text job location into one of hey.html's tabs.

hey.html's TABS are exactly: blr, pune, lko, noida, rem.
Anything that doesn't match one of these is dropped — there is no
"everything else" bucket in the tracker, so we don't invent one.
"""
import re

TAB_KEYWORDS = {
    "blr":   ["bangalore", "bengaluru", "blr"],
    "pune":  ["pune"],
    "lko":   ["lucknow", "lko"],
    "noida": ["noida", "greater noida", "ncr", "gurugram", "gurgaon",
              "delhi", "ghaziabad", "faridabad"],
    "rem":   ["remote", "work from home", "wfh", "anywhere", "hybrid remote"],
}


def classify(location_raw: str) -> str | None:
    """Return a hey.html tab key, or None if the location isn't one we track."""
    if not location_raw:
        return None
    text = location_raw.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)

    # Remote is checked first — "Remote (India)" etc. should win over any
    # city name that might also appear in the same string.
    for keyword in TAB_KEYWORDS["rem"]:
        if keyword in text:
            return "rem"

    for tab, keywords in TAB_KEYWORDS.items():
        if tab == "rem":
            continue
        for keyword in keywords:
            if keyword in text:
                return tab

    return None
