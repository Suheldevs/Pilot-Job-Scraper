/** Shared Gemini client — the only place that knows the REST shape.
 *
 *  The key lives in the Worker environment as `env.GEMINI_API_KEY` and is read
 *  from nowhere else. It is never accepted from a request body: an AI endpoint
 *  that takes its own credentials is an open proxy for anyone who can reach it,
 *  and the key would end up in browser history and request logs.
 *
 *  MODEL CHOICE (verified against the live API, not guessed):
 *    `gemini-2.0-flash`  -> 404 "This model is no longer available."
 *    `gemini-2.5-flash`  -> 404 "no longer available to new users."
 *  `GET /v1beta/models` on this key lists `gemini-3.6-flash` as the current
 *  flash tier and both 404s name it as the replacement, so that is the default.
 *  It is overridable per-deployment with `env.GEMINI_MODEL` so a model
 *  retirement is an env change rather than a code change — the retirements
 *  above are exactly why that matters.
 *
 *  Every reply is asked for as JSON (`responseMimeType: "application/json"`,
 *  plus `responseSchema` when the caller has a shape in mind) so callers parse
 *  structured data instead of regexing prose out of a paragraph.
 */

/** Verified working on 2026-09-04. Override with env.GEMINI_MODEL. */
export const DEFAULT_MODEL = "gemini-3.6-flash";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

/** A hung AI call must not hold a Worker request open. */
const DEFAULT_TIMEOUT_MS = 25_000;

/** Hard cap on what we will read back. A runaway generation is a bug, not a
 *  payload to buffer — 1 MB is far past any structured answer we ask for. */
const MAX_BODY_BYTES = 1_000_000;

/** Anything longer than this in an error message is Gemini dumping our own
 *  prompt back at us; truncate so a 400 doesn't become a wall of text. */
const MAX_ERROR_CHARS = 600;

/** Thrown for every failure mode, so handlers never see a raw fetch error.
 *  `status` is the HTTP status the endpoint should return to its caller. */
export class GeminiError extends Error {
  constructor(message, status = 502, detail = {}) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.detail = detail;
  }
}

/** True when the environment can talk to Gemini at all. Handlers use this for
 *  a clear 503 up front rather than a confusing failure three steps in. */
export function hasKey(env) {
  return typeof env?.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim().length > 0;
}

/** The 503 body for a deployment with no key. One sentence a deployer can act
 *  on — the fix is a `wrangler pages secret put`, so it says so. */
export function missingKeyError() {
  return new GeminiError(
    "GEMINI_API_KEY is not configured on this deployment — AI features are unavailable. " +
      "Set it with `wrangler pages secret put GEMINI_API_KEY` (or add it to .dev.vars locally).",
    503,
    { reason: "missing_key" }
  );
}

export function modelFor(env) {
  const m = typeof env?.GEMINI_MODEL === "string" ? env.GEMINI_MODEL.trim() : "";
  return m || DEFAULT_MODEL;
}

/** Call Gemini once and return `{ json, text, model, usage }`.
 *
 *  @param env                  Worker env — supplies GEMINI_API_KEY / GEMINI_MODEL.
 *  @param opts.prompt          The user turn. Required unless `parts` is given.
 *  @param opts.parts           Raw parts array, for inline file data (a PDF).
 *  @param opts.schema          OpenAPI-subset responseSchema. Strongly advised.
 *  @param opts.temperature     Defaults to 0.2 — these are extraction tasks.
 *  @param opts.system          Optional systemInstruction text.
 *  @param opts.timeoutMs       Defaults to 25s.
 *  @param opts.maxOutputTokens Defaults to 4096.
 *
 *  Throws GeminiError for every failure. Never throws anything else.
 */
export async function callGemini(env, opts = {}) {
  if (!hasKey(env)) throw missingKeyError();

  const {
    prompt,
    parts,
    schema = null,
    temperature = 0.2,
    system = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputTokens = 4096,
  } = opts;

  const contentParts = Array.isArray(parts) && parts.length
    ? parts
    : [{ text: String(prompt || "") }];
  if (!contentParts.length) throw new GeminiError("nothing to send to Gemini", 400);

  const model = modelFor(env);
  const generationConfig = {
    temperature: clampTemp(temperature),
    responseMimeType: "application/json",
    maxOutputTokens,
    // The 3.x flash tier thinks by default. These are extraction and drafting
    // tasks with a fixed output shape, so the cheapest level keeps latency
    // inside the timeout above without measurably worse answers.
    thinkingConfig: { thinkingLevel: "low" },
  };
  if (schema) generationConfig.responseSchema = schema;

  const payload = {
    contents: [{ role: "user", parts: contentParts }],
    generationConfig,
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

  let res;
  try {
    res = await fetch(
      `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );
  } catch (err) {
    // An abort and a DNS failure are both "we got nothing back", but they need
    // different words: one is our own deadline, the other is the network.
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new GeminiError(
        `Gemini did not respond within ${Math.round(timeoutMs / 1000)}s — try again.`,
        504,
        { reason: "timeout", model }
      );
    }
    throw new GeminiError(`could not reach Gemini: ${short(err?.message || String(err))}`, 502, {
      reason: "network",
      model,
    });
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await readCapped(res);

  // Gemini reports errors as JSON, but a gateway in front of it reports them as
  // HTML. Parse defensively so a 502 from a proxy is not read as a bad request.
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }

  if (!res.ok) throw httpError(res.status, parsed, bodyText, model);

  if (!parsed) {
    throw new GeminiError("Gemini returned a non-JSON body", 502, {
      reason: "non_json_envelope",
      model,
      body: short(bodyText),
    });
  }

  // A 200 can still carry a refusal or a truncation instead of an answer.
  const candidate = parsed.candidates?.[0];
  const finish = candidate?.finishReason || "";
  const text = (candidate?.content?.parts || [])
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("");

  if (!text) {
    const blocked = parsed.promptFeedback?.blockReason || "";
    if (blocked) {
      throw new GeminiError(`Gemini declined this request (${blocked}).`, 422, {
        reason: "blocked",
        model,
        finish,
      });
    }
    if (finish === "MAX_TOKENS") {
      throw new GeminiError(
        "Gemini hit the output limit before returning anything usable — try shorter input.",
        502,
        { reason: "max_tokens", model }
      );
    }
    throw new GeminiError("Gemini returned an empty response", 502, {
      reason: "empty",
      model,
      finish,
    });
  }

  let asJson = null;
  try {
    asJson = JSON.parse(text);
  } catch {
    // Only a real problem when the caller asked for a shape. Reported as 502
    // (upstream misbehaved) rather than 400 (the caller did nothing wrong).
    if (schema) {
      throw new GeminiError(
        finish === "MAX_TOKENS"
          ? "Gemini's answer was cut off mid-JSON — try shorter input."
          : "Gemini returned a non-JSON answer where structured JSON was requested",
        502,
        { reason: "non_json_answer", model, finish, body: short(text) }
      );
    }
  }

  return { json: asJson, text, model, usage: parsed.usageMetadata || null, finish };
}

/** Map an upstream HTTP status onto ours, keeping Gemini's own wording where it
 *  is the useful part (a schema Gemini rejected, a quota that ran out). */
function httpError(status, parsed, bodyText, model) {
  const upstream = short(parsed?.error?.message || bodyText || "");
  const detail = { reason: "upstream", upstream_status: status, model };

  if (status === 400) {
    return new GeminiError(`Gemini rejected the request: ${upstream || "bad request"}`, 400, {
      ...detail,
      reason: "bad_request",
    });
  }
  if (status === 401 || status === 403) {
    return new GeminiError(
      `Gemini rejected the API key (${status}). Check GEMINI_API_KEY. ${upstream}`.trim(),
      503,
      { ...detail, reason: "bad_key" }
    );
  }
  if (status === 404) {
    // Exactly the failure the header documents: models get retired.
    return new GeminiError(
      `Gemini model "${model}" is not available on this key (404). ${upstream} ` +
        "Set GEMINI_MODEL to a model listed by GET /v1beta/models.",
      503,
      { ...detail, reason: "no_such_model" }
    );
  }
  if (status === 429) {
    return new GeminiError(
      `Gemini quota or rate limit reached — wait and retry. ${upstream}`.trim(),
      429,
      { ...detail, reason: "quota" }
    );
  }
  if (status >= 500) {
    return new GeminiError(`Gemini is unavailable right now (${status}). ${upstream}`.trim(), 502, {
      ...detail,
      reason: "upstream_down",
    });
  }
  return new GeminiError(`Gemini returned ${status}. ${upstream}`.trim(), 502, detail);
}

/** Read the body without letting a runaway generation buffer unbounded. */
async function readCapped(res) {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > MAX_BODY_BYTES) {
    throw new GeminiError("Gemini response was too large to read", 502, {
      reason: "too_large",
      bytes: declared,
    });
  }
  if (!res.body) return await res.text();

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new GeminiError("Gemini response exceeded the size cap", 502, {
          reason: "too_large",
          bytes: total,
        });
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof GeminiError) throw err;
    throw new GeminiError(`could not read Gemini's response: ${short(err?.message || "")}`, 502, {
      reason: "read_failed",
    });
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function clampTemp(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return 0.2;
  return Math.min(2, Math.max(0, n));
}

function short(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > MAX_ERROR_CHARS ? `${t.slice(0, MAX_ERROR_CHARS)}…` : t;
}

/** Turn any thrown error into the Response an endpoint should return.
 *  A non-GeminiError is a bug in our own handler, so it becomes a plain 500
 *  with no stack — never a raw throw escaping to the client. */
export function geminiErrorResponse(err) {
  const isKnown = err instanceof GeminiError;
  const status = isKnown ? err.status : 500;
  const body = {
    error: isKnown ? err.message : "unexpected error while calling Gemini",
  };
  if (isKnown && err.detail?.reason) body.reason = err.detail.reason;
  if (isKnown && err.detail?.model) body.model = err.detail.model;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
