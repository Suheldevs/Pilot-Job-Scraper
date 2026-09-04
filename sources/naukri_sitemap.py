r"""Naukri — read the public sitemaps instead of the search API.

The search endpoint (`sources/naukri.py`, `/jobapi/v3/search`) sits behind a
reCAPTCHA gate and mostly answers 406. The sitemaps are the same site's own
published index — naukri.com/robots.txt advertises them — so they are the
honest way in, and they need no headers, no tokens and no bypass.

The trick that makes this cheap: the JD-page slug already carries the
metadata we filter on.

    /job-listings-fullstack-developer-impelsys-bengaluru-2-to-3-years-210826018810
     \_______ role _______/ \_ company _/ \_ city _/ \_ exp _/ \_ id _/

So every filter runs against the URL string and we never fetch a job page.
That also means `jd_text` stays empty, deliberately: the JD page is
client-rendered (no description in the HTML) and `GET /jobapi/v3/job/{id}`
answers `406 recaptcha required`. There is no description to be had from
here, and inventing one would poison the scoring layer. Same for
`posted_at` — the slug's leading digits look like a date but are part of the
job id, so we leave the field empty rather than guess.
"""
import gzip
import re
from typing import Dict, List, Optional

import httpx

import config
import locations
from models import Job
from sources.base import Source

INDEX = "https://www.naukri.com/sitemap/sitemap.xml"

# The freshest JD pages live in these children. They are listed inside
# `incremental-jd-pages.xml` (itself a <sitemapindex>) rather than at the top
# level, so discovery has to follow one hop — see _discover_files().
LATEST_PATTERN = re.compile(r"latest-jd-pages-\d+\.xml(?:\.gz)?$", re.I)
NESTED_INDEX_PATTERN = re.compile(r"incremental-jd-pages\.xml(?:\.gz)?$", re.I)
FALLBACK_FILES = [
    f"https://www.naukri.com/sitemap/sitemap-latest-jd-pages-{n}.xml.gz"
    for n in (1, 2, 3)
]

LOC_PATTERN = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)

# job-listings-<slug>-<numeric id>. The id is 12 digits today; accept 6+ so a
# format change shortens the match instead of dropping every row.
SLUG_PATTERN = re.compile(r"/job-listings-(.+?)-(\d{6,})/?$")
EXPERIENCE_PATTERN = re.compile(r"-(\d{1,2})-to-(\d{1,2})-years$")

# Words that end a job title. The slug has no delimiter between role and
# company, so the head noun is the only structural signal for where one stops
# and the other starts: "senior-java-developer-bounteous" splits after
# "developer". Without one we cannot split at all, and a mangled company name
# is worse for deduping than a dropped row.
_HEAD_NOUNS = {
    "developer", "developers", "engineer", "engineers", "engineering",
    "programmer", "programming", "architect", "architecture", "lead", "leader",
    "consultant", "intern", "internship", "trainee", "trainer", "designer",
    "designing", "analyst", "analytics", "specialist", "manager", "executive",
    "officer", "associate", "assistant", "director", "head", "president",
    "administrator", "admin", "technician", "coordinator", "supervisor",
    "representative", "agent", "advisor", "adviser", "scientist", "researcher",
    "recruiter", "accountant", "auditor", "chef", "nurse", "doctor", "teacher",
    "tutor", "faculty", "professor", "operator", "operations", "driver",
    "clerk", "cashier", "receptionist", "secretary", "writer", "editor",
    "tester", "testing", "coder", "development", "sde", "swe", "dev", "devops",
    "sre", "qa", "tl", "sme", "cto", "ceo", "cfo", "coo", "vp", "avp", "gm",
    "expert", "strategist", "planner", "controller", "technologist",
    "practitioner", "counsellor", "counselor", "therapist", "pharmacist",
    "technical", "support", "staff", "apprentice", "fresher", "freshers",
    "professional", "professionals", "generalist", "partner", "principal",
    "fellow", "sales",
}

# Tokens that may trail the head noun and still belong to the title
# ("full-stack-developer-python-react-66degrees" -> company is 66degrees).
# Without this the stack list leaks into the company name.
_TITLE_TAIL = {
    "java", "python", "node", "nodejs", "js", "javascript", "typescript", "ts",
    "react", "reactjs", "angular", "angularjs", "vue", "vuejs", "net",
    "dotnet", "php", "ruby", "rails", "golang", "go", "rust", "scala",
    "kotlin", "swift", "flutter", "django", "flask", "spring", "boot",
    "springboot", "microservices", "mern", "mean", "fullstack", "stack",
    "aws", "azure", "gcp", "cloud", "docker", "kubernetes", "k8s", "sql",
    "mysql", "postgres", "postgresql", "mongodb", "mongo", "redis", "graphql",
    "rest", "api", "apis", "html", "css", "sass", "tailwind", "nextjs", "next",
    "nest", "nestjs", "express", "laravel", "symfony", "codeigniter", "genai",
    "ai", "ml", "llm", "frontend", "backend", "ui", "ux", "web", "mobile",
    "android", "ios", "native", "sap", "salesforce", "oracle", "hana", "abap",
    "selenium", "cypress", "jest", "years", "year", "yrs", "yr", "exp",
    "experience", "hiring", "urgent", "immediate", "joiner", "joiners",
    "opening", "openings", "remote", "wfh", "onsite", "hybrid",
}

# Connectors are only absorbed when a title token follows them, so
# "fullstack-development-with-python-anlage" keeps "with python" in the role.
_CONNECTORS = {"with", "and", "in", "for", "using", "at", "on", "of", "the", "a"}


def _city_vocabulary() -> set:
    """Every city token we can recognise at the tail of a slug.

    locations.TAB_KEYWORDS is the authority on what we keep, but recognising
    only those five would leave "virtusa-hyderabad-chennai-bengaluru" with two
    stray city names glued to the company. So the set is deliberately wider
    than what we track: extra names are used to *strip*, never to keep —
    locations.classify() still decides that.
    """
    vocab = set()
    for keywords in locations.TAB_KEYWORDS.values():
        for keyword in keywords:
            vocab.update(keyword.split())
    vocab.update({
        "mumbai", "navi", "thane", "chennai", "hyderabad", "secunderabad",
        "kolkata", "ahmedabad", "surat", "vadodara", "rajkot", "jaipur",
        "indore", "bhopal", "nagpur", "nashik", "aurangabad", "coimbatore",
        "madurai", "kochi", "cochin", "ernakulam", "trivandrum",
        "thiruvananthapuram", "kozhikode", "mysore", "mysuru", "mangalore",
        "mangaluru", "hubli", "belgaum", "chandigarh", "mohali", "panchkula",
        "zirakpur", "ludhiana", "amritsar", "jalandhar", "dehradun",
        "haridwar", "kanpur", "varanasi", "agra", "prayagraj", "allahabad",
        "meerut", "bareilly", "gorakhpur", "patna", "ranchi", "jamshedpur",
        "bhubaneswar", "cuttack", "raipur", "bhilai", "guwahati", "shillong",
        "siliguri", "durgapur", "asansol", "vijayawada", "visakhapatnam",
        "vizag", "guntur", "tirupati", "nellore", "warangal", "salem",
        "tiruchirappalli", "trichy", "tirunelveli", "erode", "vellore",
        "pondicherry", "puducherry", "goa", "panaji", "panjim", "udaipur",
        "jodhpur", "kota", "ajmer", "bikaner", "gwalior", "jabalpur", "ujjain",
        "solapur", "kolhapur", "sangli", "satara", "ahmednagar", "jamnagar",
        "bhavnagar", "gandhinagar", "anand", "bharuch", "vapi", "valsad",
        "silvassa", "daman", "srinagar", "jammu", "shimla", "roorkee",
        "moradabad", "aligarh", "mathura", "jhansi", "saharanpur",
        "muzaffarnagar", "india", "areas", "all",
        # Qualifiers that only ever get eaten when a real city sits to their
        # right, because the scan runs right-to-left: "printways-new-delhi"
        # loses "new delhi", "amar-ujala" keeps its name.
        "new", "old", "greater", "east", "west", "north", "south", "central",
    })
    return vocab


_CITY_TOKENS = _city_vocabulary()


def _word_boundary_patterns(keywords: List[str]) -> List[re.Pattern]:
    """Compile keywords so they only match whole alphanumeric runs.

    The other sources test `kw in haystack`, which makes "react" match
    "reactivations" and "node" match "nodal" — both real false positives in
    this feed. Lookarounds on [a-z0-9] (rather than \\b) keep working for
    keywords that contain punctuation, like "next.js" and "front-end".
    """
    return [
        re.compile(r"(?<![a-z0-9])" + re.escape(kw.lower()) + r"(?![a-z0-9])")
        for kw in keywords
    ]


def parse_slug(url: str) -> Optional[Dict]:
    """Pull role / company / city / experience / id out of a JD URL.

    Returns None when the slug cannot be split with confidence — slugs vary a
    lot and a half-parsed row is worse than no row.
    """
    match = SLUG_PATTERN.search(url)
    if not match:
        return None
    slug, job_id = match.group(1), match.group(2)

    # Experience first: it is the one anchored, unambiguous part of the tail.
    exp_min = exp_max = None
    exp_match = EXPERIENCE_PATTERN.search(slug)
    if exp_match:
        exp_min, exp_max = int(exp_match.group(1)), int(exp_match.group(2))
        slug = slug[: exp_match.start()]

    tokens = [t for t in slug.split("-") if t]
    if not tokens:
        return None

    # City run sits at the end, and can hold several cities.
    end = len(tokens)
    while end > 0 and tokens[end - 1] in _CITY_TOKENS:
        end -= 1
    head_tokens, city_tokens = tokens[:end], tokens[end:]

    # Role runs from the start to the FIRST head noun (plus any trailing stack
    # words). First, not last, because company names contain head nouns too:
    # "react-native-developer-moolya-software-testing" must cut at "developer".
    cut = next((i for i, t in enumerate(head_tokens) if t in _HEAD_NOUNS), None)
    if cut is None:
        return None
    cut += 1
    while cut < len(head_tokens):
        token = head_tokens[cut]
        if token in _HEAD_NOUNS or token in _TITLE_TAIL or token.isdigit():
            cut += 1
        elif (token in _CONNECTORS and cut + 1 < len(head_tokens)
              and (head_tokens[cut + 1] in _TITLE_TAIL
                   or head_tokens[cut + 1] in _HEAD_NOUNS)):
            cut += 1
        else:
            break

    role_tokens, company_tokens = head_tokens[:cut], head_tokens[cut:]
    if not role_tokens or not company_tokens:
        return None

    return {
        "role": " ".join(role_tokens),
        "company": " ".join(company_tokens),
        "city": " ".join(city_tokens),
        "exp_min": exp_min,
        "exp_max": exp_max,
        "job_id": job_id,
    }


class NaukriSitemapSource(Source):
    # Distinct from NaukriSource.name on purpose: the circuit breaker keys off
    # `name`, and the blocked /jobapi/ source must not be able to open the
    # breaker for this one, which works fine.
    name = "naukri_sitemap"

    def __init__(self, max_files: int = 2) -> None:
        # Each file is ~640 KB gzipped and holds ~25,000 URLs. Two is already
        # 50,000 slugs to filter; pulling all three by default would triple
        # the download for the tail end of the same day's postings.
        self.max_files = max_files

    def _collect_impl(self) -> List[Job]:
        jobs: List[Job] = []
        headers = {"User-Agent": config.USER_AGENT, "Accept": "application/xml"}
        seen_ids: set = set()

        # Counters, printed at the end: without them a low yield is
        # indistinguishable from a broken parser.
        raw = unparsed = kw_ok = exp_ok = loc_ok = 0

        with httpx.Client(headers=headers, follow_redirects=True) as client:
            files = self._discover_files(client)[: self.max_files]
            if not files:
                print(f"[{self.name}] no JD sitemap files found")
                return jobs

            patterns = _word_boundary_patterns(config.MATCH_KEYWORDS)

            for url in files:
                urls = self._read_sitemap(client, url)
                raw += len(urls)

                for job_url in urls:
                    parsed = parse_slug(job_url)
                    if parsed is None:
                        unparsed += 1
                        continue

                    # Cheapest filter first — the role is one short string.
                    if not any(p.search(parsed["role"]) for p in patterns):
                        continue
                    kw_ok += 1

                    if not self._experience_overlaps(parsed):
                        continue
                    exp_ok += 1

                    if not locations.classify(parsed["city"]):
                        continue
                    loc_ok += 1

                    # The same job id can appear in more than one file.
                    if parsed["job_id"] in seen_ids:
                        continue
                    seen_ids.add(parsed["job_id"])

                    jobs.append(Job(
                        company=parsed["company"],
                        role=parsed["role"],
                        url=job_url,
                        platform="naukri",  # same site, so the dashboard tag reads "Naukri"
                        location_raw=parsed["city"],
                        jd_text="",  # no description exists — see module docstring
                    ))

                self._pace()

        print(f"[{self.name}] {raw} urls -> {raw - unparsed} parsed "
              f"({unparsed} unparseable) -> {kw_ok} keyword -> {exp_ok} experience "
              f"-> {loc_ok} location -> {len(jobs)} unique")
        return jobs

    def _discover_files(self, client: httpx.Client) -> List[str]:
        """Find the latest-JD sitemap children, preferring what the site lists."""
        resp = self._fetch(client, INDEX)
        if resp is None:
            print(f"[{self.name}] sitemap index unreachable, using known names")
            return list(FALLBACK_FILES)

        entries = LOC_PATTERN.findall(resp.text)
        files = [u for u in entries if LATEST_PATTERN.search(u)]

        # The top level lists a nested <sitemapindex> instead of the children
        # themselves, so follow it before falling back to hardcoded names.
        if not files:
            for nested in (u for u in entries if NESTED_INDEX_PATTERN.search(u)):
                self._pace()
                nested_resp = self._fetch(client, nested)
                if nested_resp is None:
                    continue
                files.extend(u for u in LOC_PATTERN.findall(nested_resp.text)
                             if LATEST_PATTERN.search(u))

        if not files:
            print(f"[{self.name}] index did not list latest-jd-pages, "
                  f"falling back to known names")
            files = list(FALLBACK_FILES)

        return sorted(set(files))

    def _read_sitemap(self, client: httpx.Client, url: str) -> List[str]:
        """Fetch one sitemap child and return its <loc> URLs."""
        resp = self._fetch(client, url)
        if resp is None:
            return []

        body = resp.content
        # These are served as application/x-gzip with no Content-Encoding, so
        # httpx hands back the raw gzip stream. Sniff the magic bytes instead
        # of trusting the .gz suffix — a proxy that decompresses transparently
        # would otherwise break us.
        if body[:2] == b"\x1f\x8b":
            try:
                body = gzip.decompress(body)
            except (OSError, EOFError) as e:
                print(f"[{self.name}] could not decompress {url[:80]}: {e}")
                return []

        text = body.decode("utf-8", errors="replace")
        return [u for u in LOC_PATTERN.findall(text) if "/job-listings-" in u]

    @staticmethod
    def _experience_overlaps(parsed: Dict) -> bool:
        """Keep a job whose range touches ours, and keep it when unstated.

        A missing range is missing data, not a mismatch — dropping those would
        penalise the posting for the site's own formatting.
        """
        if parsed["exp_min"] is None or parsed["exp_max"] is None:
            return True
        return (parsed["exp_min"] <= config.MAX_EXPERIENCE_YEARS
                and parsed["exp_max"] >= config.MIN_EXPERIENCE_YEARS)
