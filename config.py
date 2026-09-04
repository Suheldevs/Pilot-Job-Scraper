"""Defaults tuned to the profile in hey.html — edit freely."""

# Search phrases sent to sources with a server-side keyword search
# (Naukri, LinkedIn) — kept short: each extra phrase is extra requests
# against sites that actively rate-limit.
ROLE_KEYWORDS = [
    "full stack developer",
    "mern stack developer",
    "react developer",
    "node js developer",
]

# Broader tokens used to filter sources that hand back an unfiltered feed
# (RemoteOK, We Work Remotely) — matched as substrings, so short and loose
# on purpose. A full-phrase match here misses real titles like "Full Stack
# Engineer" or "Senior React Developer".
MATCH_KEYWORDS = [
    "react", "node", "mern", "full stack", "fullstack",
    "javascript", "typescript", "next.js", "nextjs",
    "frontend", "front-end", "backend", "express", "mongodb",
]

# City search terms — must match something locations.py can classify,
# otherwise the results get collected then silently dropped.
LOCATIONS = ["Bangalore", "Pune", "Lucknow", "Noida", "Remote"]

MIN_EXPERIENCE_YEARS = 1
MAX_EXPERIENCE_YEARS = 3

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

REQUEST_TIMEOUT = 20.0
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0       # seconds, doubled each retry
DELAY_BETWEEN_REQUESTS = 2.0  # seconds, between successful requests to the same host

# Pages fetched per (keyword, location) pair, per source.
NAUKRI_MAX_PAGES = 2
LINKEDIN_MAX_PAGES = 2
