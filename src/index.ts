interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * California manufacturer drug list-price (WAC) disclosures — HCAI Cost
 * Transparency Rx (CTRx) program (fleet #3245).
 *
 * California's SB 17 / AB 265 requires drug manufacturers to notify the
 * Department of Health Care Access and Information (HCAI) whenever they:
 *   - raise a drug's Wholesale Acquisition Cost (WAC — the published list
 *     price before rebates/discounts) past a statutory threshold (currently:
 *     WAC after increase > $40 for a course of therapy AND a cumulative
 *     increase > 16% over the prior 3 calendar years), or
 *   - introduce a NEW drug whose launch WAC exceeds the Medicare Part D
 *     specialty-drug cost threshold.
 *
 * HCAI publishes every completed report as open, keyless CKAN datasets on
 * data.chhs.ca.gov, split one "monthly" (in-progress current year) resource
 * plus one closed annual archive per calendar year back to 2019. This pack
 * reads that live — there is nothing to mirror.
 *
 * WHY THIS IS CALIFORNIA-ONLY. Several other states run a similar manufacturer
 * WAC-disclosure program (Oregon, Colorado, Vermont, Nevada, Minnesota,
 * Washington, Maine…), but California is the ONLY one found (fleet #3245
 * survey, 2026-10-18) that publishes the underlying reports as a structured,
 * queryable public dataset rather than a narrative PDF. Multiplexing states
 * behind one pack is the thing CLAUDE.md's "one pack per jurisdiction" rule
 * exists to prevent — grain, schema and even the reporting threshold differ
 * per state, so a second state (if its data ever becomes structured) gets its
 * own pack, not a `state` argument here. See README "Coverage" for the
 * state-by-state survey, including which ones are genuinely unbuildable today
 * (PDF-only, or restricted to manufacturer accounts) versus which one (MN) is
 * public-and-structured but a bulk-file local-copy build, not live.
 *
 * TWO HEADER SHAPES PER DATASET, AND THEY DIFFER (hit while building this).
 * HCAI's "current year, in progress" resource uses snake_case machine
 * column names (`manufacturer_name`, `wac_effective_date`, …). Every CLOSED
 * annual archive (2019 through last full year) uses human Title Case column
 * names with spaces ("Manufacturer Name", "WAC Effective Date", …) AND
 * stringifies numbers that the current-year resource returns as JSON numbers.
 * The 5-year-history resource additionally prefixes its dollar amounts with
 * "$" and commas in BOTH shapes. Every normalizer here reads both spellings
 * and parses both number encodings — matching on the Title-Case name alone
 * silently drops every closed year.
 *
 * RESOURCE IDS ARE RESOLVED LIVE, NOT HARDCODED, because the "current year"
 * resource becomes a dated archive every January and HCAI's own numbering
 * (like CMS's NADAC dataset id, see mcps/drug-prices) is not guaranteed
 * stable across that rollover. `resolveResources()` reads CKAN's
 * `package_show` for the two CTRx packages and classifies every resource by
 * its NAME, with the last-known-good ids (captured 2026-10-18) as a fallback
 * if that lookup itself fails.
 */


const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const CKAN_BASE = 'https://data.chhs.ca.gov/api/3/action';
const PUBLISHER =
  'California Department of Health Care Access and Information (HCAI), Cost Transparency Rx (CTRx) program';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'HCAI CTRx (data.chhs.ca.gov)');
}

const clamp = (v: unknown, def: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
};

// ---- Resource resolution --------------------------------------------------

/** Last-known-good resource ids, captured 2026-10-18. Used only if the live
 *  package_show lookup below fails — never read unconditionally, because a
 *  stale id silently stops picking up new report years. */
const FALLBACK: Record<'wac' | 'wac5yr' | 'newdrug', Record<string, string>> = {
  wac: {
    '2026': 'dda8a083-bc81-4f6d-b02f-935a2df70328',
    '2025': '46b78eef-5952-4fff-84c7-1fa758990ce8',
    '2024': '882bb30d-44ed-48c9-b722-beb5aedc2c1b',
    '2023': 'aca55cd5-a1a7-49cb-a490-997df1e27480',
    '2022': 'dbed46b3-e823-487a-8a96-c0b2381af2c9',
    '2021': '34c373bb-cf9a-463e-93bf-6ae4ff3afad8',
    '2020': 'f3e4ba62-3df4-40dd-9876-f7aea7384c1b',
    '2019': '9b8e12dc-1b3c-4c36-9ba9-adba6b921a6c',
  },
  wac5yr: {
    '2026': 'd754c567-c3c3-4ecf-a236-8144578549dd',
    '2025': 'e2c970a8-a2ab-436c-a47e-10986572df1c',
    '2024': '225c5d83-d8cd-4aea-aa55-faca99501def',
    '2023': '91dbf176-8349-4d65-a7ca-d2f3ffb8d726',
    '2022': '252a735f-e49d-4d73-9955-e79de8adabb1',
    '2021': 'ccc65919-378c-408e-85fb-164e4975de58',
    '2020': 'b57d3435-a56c-4f74-83b3-d54775a005a2',
    '2019': '568dc2b7-c493-431a-8113-49c6bcad0457',
  },
  newdrug: {
    '2026': '2be5663e-8862-42e8-bd0e-3476d8baf7c3',
    '2025': '80eea566-e1a0-4b62-884b-b0dfb58887e3',
    '2024': '0e3afcfc-a5eb-41c6-a633-deaa2bfb5710',
    '2023': 'f0899438-0fb5-42d5-87f5-621e2f0b1b51',
    '2022': '11a91095-1597-4b6a-b0b3-09e76422ce40',
    '2021': '5a80b890-24bb-4d66-a0bb-d6c46a150065',
    '2020': '9a37709e-4151-4300-a031-91ea7813da60',
    '2019': '6393cda0-6101-424e-b738-07aee9e6f94f',
  },
};

const PACKAGE_IDS = {
  wacFamily: 'prescription-drug-wholesale-acquisition-cost-wac-increases',
  newDrugFamily: 'prescription-drugs-introduced-to-market',
};

interface ResourceMaps {
  wac: Record<string, string>;
  wac5yr: Record<string, string>;
  newdrug: Record<string, string>;
}

let cache: { at: number; maps: ResourceMaps } | null = null;
const CACHE_MS = 60 * 60 * 1000; // 1 hour — this is a runtime memo, not baked data

function classifyWacResource(name: string): { year: string; kind: 'wac' | 'wac5yr' } | null {
  const isHistory = /5 Year History/i.test(name);
  const monthly = /Monthly Update.*\(CSV\)/i.test(name) && !/Excel/i.test(name);
  if (monthly) {
    const yearMatch = name.match(/(\d{4})\s+Monthly Update/i);
    const year = yearMatch ? yearMatch[1] : String(new Date().getUTCFullYear());
    return { year, kind: isHistory ? 'wac5yr' : 'wac' };
  }
  // Closed-year archives ship XLSX only (no CSV sibling) and their name
  // carries no format marker, so any "Q1-Q4 <year>" match not already
  // claimed by the monthly/CSV branch above is an annual archive.
  const annual = name.match(/Q1-Q4 (\d{4})/i);
  if (annual) return { year: annual[1], kind: isHistory ? 'wac5yr' : 'wac' };
  return null;
}

function classifyNewDrugResource(name: string): { year: string } | null {
  const monthly = /Monthly Update.*\(CSV\)/i.test(name);
  if (monthly) {
    const yearMatch = name.match(/(\d{4})\s+Monthly Update/i);
    return { year: yearMatch ? yearMatch[1] : String(new Date().getUTCFullYear()) };
  }
  const annual = name.match(/Q1-Q4 (\d{4})/i);
  if (annual) return { year: annual[1] };
  return null;
}

async function packageShow(id: string): Promise<any[]> {
  const res = await pwFetch(`${CKAN_BASE}/package_show?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`${res.status} fetching ${id}`);
  const body = (await res.json()) as any;
  if (!body?.success) throw new Error(`package_show(${id}) returned success=false`);
  return body.result.resources ?? [];
}

async function resolveResources(): Promise<ResourceMaps> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.maps;
  try {
    const [wacResources, newDrugResources] = await Promise.all([
      packageShow(PACKAGE_IDS.wacFamily),
      packageShow(PACKAGE_IDS.newDrugFamily),
    ]);
    const wac: Record<string, string> = {};
    const wac5yr: Record<string, string> = {};
    for (const r of wacResources) {
      if (r.format !== 'CSV' && r.format !== 'XLSX') continue;
      if (/Data Dictionary/i.test(r.name) || r.format === 'XLSX' && /Monthly Update/i.test(r.name)) continue;
      const classified = classifyWacResource(r.name);
      if (!classified) continue;
      if (classified.kind === 'wac') wac[classified.year] = r.id;
      else wac5yr[classified.year] = r.id;
    }
    const newdrug: Record<string, string> = {};
    for (const r of newDrugResources) {
      if (r.format !== 'CSV' && r.format !== 'XLSX') continue;
      if (/Data Dictionary/i.test(r.name) || (r.format === 'XLSX' && /Monthly Update/i.test(r.name))) continue;
      const classified = classifyNewDrugResource(r.name);
      if (!classified) continue;
      newdrug[classified.year] = r.id;
    }
    // Sanity floor: if live classification found fewer years than the
    // fallback, something about HCAI's naming changed — merge rather than
    // trust a partial live result silently.
    const maps: ResourceMaps = {
      wac: { ...FALLBACK.wac, ...wac },
      wac5yr: { ...FALLBACK.wac5yr, ...wac5yr },
      newdrug: { ...FALLBACK.newdrug, ...newdrug },
    };
    cache = { at: Date.now(), maps };
    return maps;
  } catch {
    return FALLBACK;
  }
}

// ---- CKAN datastore_search --------------------------------------------------

/** CKAN's datastore_search `q` parameter is a cross-column full-text relevance
 *  search (it ranks hits across every text column, including long narrative
 *  fields like "General Comments"), NOT a substring match on the field being
 *  searched — measured 2026-10-18: `q=Pfizer` on a 1,251-row resource with
 *  ZERO rows naming Pfizer still returned `total: 151`. Worse, it is capped at
 *  the resource's relevance ranking, so a real match outside the top N by rank
 *  could be silently missed. `datastore_search_sql` (also keyless, confirmed
 *  live) is used instead, with an explicit ILIKE on the exact column for the
 *  field actually being searched. */
function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Column names differ by header shape — see the file header. `isCurrent`
 *  selects which spelling to filter on. */
function cols(isCurrent: boolean) {
  return isCurrent
    ? { manufacturer: 'manufacturer_name', ndc: 'ndc', drug: 'drug_prod_desc' }
    : { manufacturer: '"Manufacturer Name"', ndc: '"NDC Number"', drug: '"Drug Product Description"' };
}

async function sqlSearch(resourceId: string, where: string[], limit: number): Promise<any[]> {
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM "${resourceId}"${whereSql} LIMIT ${limit}`;
  const res = await pwFetch(`${CKAN_BASE}/datastore_search_sql?${new URLSearchParams({ sql }).toString()}`);
  if (!res.ok) throw new Error(`${res.status} querying resource ${resourceId}`);
  const body = (await res.json()) as any;
  if (!body?.success) return [];
  return body.result?.records ?? [];
}

// ---- Normalization: both header shapes, per dataset -------------------------

function v(r: Record<string, any>, ...keys: string[]): any {
  for (const k of keys) {
    if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
  }
  return null;
}

function num(x: any): number | null {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return x;
  const cleaned = String(x).replace(/[$,]/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Normalizes both "YYYY-MM-DDT00:00:00" (current-year resource) and
 *  "MM/DD/YYYY" (closed-year archive) into YYYY-MM-DD. Null passes through —
 *  a missing date here is a real missing value, not a parse failure. */
function isoDate(x: any): string | null {
  if (!x) return null;
  const s = String(x).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  return s;
}

function normalizeWac(r: Record<string, any>, year: string, isCurrent: boolean) {
  return {
    manufacturer: v(r, 'manufacturer_name', 'Manufacturer Name'),
    ndc: String(v(r, 'ndc', 'NDC Number') ?? ''),
    drug: v(r, 'drug_prod_desc', 'Drug Product Description'),
    drug_category: v(r, 'drug_category', 'Drug Category'),
    wac_effective_date: isoDate(v(r, 'wac_effective_date', 'WAC Effective Date')),
    wac_increase_amount: num(v(r, 'wac_increase_amount', 'WAC Increase Amount')),
    wac_after_increase: num(v(r, 'wac_after_increase', 'WAC After Increase')),
    patent_expiration_date: isoDate(v(r, 'patent_expiration_date', 'Patent Expiration Date')),
    drug_source_type: v(r, 'drug_source_type', 'Drug Source Type'),
    cost_increase_factors: v(r, 'cost_increase_factors', 'Cost Increase Factors'),
    report_year: year,
    report_status: isCurrent ? 'in-progress (current year, subject to late filings)' : 'closed annual archive',
  };
}

function normalizeWac5yr(r: Record<string, any>, year: string) {
  return {
    manufacturer: v(r, 'manufacturer_name', 'Manufacturer Name'),
    ndc: String(v(r, 'ndc', 'NDC Number') ?? ''),
    effective_date: isoDate(v(r, 'effective_date', 'Effective Date')),
    history_effective_date: isoDate(v(r, 'history_effective_date', 'History Effective Date')),
    wac_increase_amount: num(v(r, 'wac_increase_amount', 'WAC Increase Amount')),
    wac_amount: num(v(r, 'wac_amount', 'WAC Amount')),
    report_year: year,
  };
}

function normalizeNewDrug(r: Record<string, any>, year: string, isCurrent: boolean) {
  return {
    manufacturer: v(r, 'manufacturer_name', 'Manufacturer Name'),
    ndc: String(v(r, 'ndc', 'NDC Number') ?? ''),
    drug: v(r, 'drug_prod_desc', 'Drug Product Description'),
    drug_category: v(r, 'drug_category', 'Drug Category'),
    introduced_to_market_date: isoDate(
      v(r, 'introduced_to_market_date', 'Date Introduced to Market')
    ),
    wac_at_introduction: num(v(r, 'wac_at_introduction', 'WAC at Introduction')),
    estimated_patients: num(v(r, 'estimated_patients', 'Estimated Number of Patients')),
    breakthrough_therapy: v(r, 'breakthrough_therapy_indicator', 'Breakthrough Therapy Indicator'),
    priority_review: v(r, 'priority_review_indicator', 'Priority Review Indicator'),
    marketing_pricing_plan_desc: v(
      r,
      'marketing_pricing_plan_desc',
      'Marketing/Pricing Plan Description'
    ),
    report_year: year,
    report_status: isCurrent ? 'in-progress (current year, subject to late filings)' : 'closed annual archive',
  };
}

// ---- Tools ------------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'ca_rx_wac_increases',
    description:
      'California manufacturer disclosures of a prescription drug\'s Wholesale Acquisition Cost (WAC — the published list price before rebates/discounts) going UP. Required by California law (SB 17/AB 265) whenever a drug\'s WAC exceeds $40 for a course of therapy AND the increase exceeds the statutory cumulative threshold; filed with HCAI\'s Cost Transparency Rx (CTRx) program. Search by drug name/fragment, manufacturer, or NDC, optionally pinned to one report year (2019-present; omit to search every year). Returns each increase\'s amount, the WAC after the increase, and whether the record comes from the still-open current year or a closed annual archive. This is the LIST price a manufacturer sets, not what any payer or pharmacy actually pays — for that, see the drug-prices pack\'s nadac_price/asp_payment_limit tools. California-only: see the pack README for which other states publish this and in what form. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        drug: { type: 'string', description: 'Drug name or fragment, e.g. "Humira", "insulin glargine", matched against the drug product description.' },
        manufacturer: { type: 'string', description: 'Manufacturer name or fragment, e.g. "AbbVie", "Novo Nordisk".' },
        ndc: { type: 'string', description: 'National Drug Code, any common format.' },
        year: { type: 'string', description: 'Report year, "2019".."2026". Omit to search every available year (recommended for a single drug/manufacturer/NDC lookup).' },
        limit: { type: 'number', description: 'Max records to return, 1-100 (default 25).' },
      },
    },
  },
  {
    name: 'ca_rx_wac_five_year_history',
    description:
      'The 5-year WAC increase history California requires manufacturers to disclose alongside each WAC Increase Report — every prior increase for that NDC over the preceding 5 calendar years, with its date and amount. Use this to see a drug\'s full price trajectory rather than just its latest jump (ca_rx_wac_increases). Lookup is by NDC (get one from ca_rx_wac_increases first if you only have a drug name). Part of HCAI\'s CTRx program. California-only. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        ndc: { type: 'string', description: 'National Drug Code, any common format.' },
        year: { type: 'string', description: 'Report year to pin to, "2019".."2026". Omit to search every available year.' },
        limit: { type: 'number', description: 'Max history rows to return, 1-200 (default 50).' },
      },
      required: ['ndc'],
    },
  },
  {
    name: 'ca_rx_new_drug_launches',
    description:
      'California manufacturer disclosures of a NEW prescription drug launched with a Wholesale Acquisition Cost (WAC — published list price) exceeding the Medicare Part D specialty-drug cost threshold — California\'s "launch price" transparency requirement, filed with HCAI\'s Cost Transparency Rx (CTRx) program (same law as ca_rx_wac_increases, different trigger: a NEW drug\'s starting price rather than an existing drug\'s price increase). Search by drug name/fragment or manufacturer, optionally pinned to one report year (2019-present). Returns the launch WAC, estimated patient population, and breakthrough-therapy/priority-review FDA designations when disclosed. California-only. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        drug: { type: 'string', description: 'Drug name or fragment, e.g. "Vraylar", "Opdualag".' },
        manufacturer: { type: 'string', description: 'Manufacturer name or fragment, e.g. "AbbVie", "Bristol Myers Squibb".' },
        year: { type: 'string', description: 'Report year, "2019".."2026". Omit to search every available year.' },
        limit: { type: 'number', description: 'Max records to return, 1-100 (default 25).' },
      },
    },
  },
];

function yearsToSearch(maps: Record<string, string>, year: unknown): string[] {
  if (typeof year === 'string' && year.trim()) {
    const y = year.trim();
    return maps[y] ? [y] : [];
  }
  return Object.keys(maps).sort((a, b) => Number(b) - Number(a));
}

async function wacIncreaseSearch(args: Record<string, unknown>) {
  const drug = typeof args.drug === 'string' ? args.drug.trim() : '';
  const manufacturer = typeof args.manufacturer === 'string' ? args.manufacturer.trim() : '';
  const ndc = typeof args.ndc === 'string' ? args.ndc.replace(/\D/g, '') : '';
  const limit = clamp(args.limit, 25, 100);
  const maps = await resolveResources();
  const years = yearsToSearch(maps.wac, args.year);
  const currentYear = String(new Date().getUTCFullYear());

  const perYear = await Promise.all(
    years.map(async (year) => {
      const isCurrent = year === currentYear;
      const c = cols(isCurrent);
      const where: string[] = [];
      if (drug) where.push(`${c.drug} ILIKE ${sqlLit(`%${drug}%`)}`);
      if (manufacturer) where.push(`${c.manufacturer} ILIKE ${sqlLit(`%${manufacturer}%`)}`);
      if (ndc) where.push(`${c.ndc}::text ILIKE ${sqlLit(`%${ndc}%`)}`);
      try {
        const records = await sqlSearch(maps.wac[year], where, 500);
        return records.map((r) => normalizeWac(r, year, isCurrent));
      } catch {
        return [];
      }
    })
  );
  let rows = perYear.flat();
  if (ndc) rows = rows.filter((r) => r.ndc.replace(/\D/g, '').includes(ndc));
  rows.sort((a, b) => (b.wac_effective_date ?? '').localeCompare(a.wac_effective_date ?? ''));
  const total = rows.length;
  rows = rows.slice(0, limit);

  if (total === 0) {
    return {
      publisher: PUBLISHER,
      count: 0,
      years_searched: years,
      filters_tried: { drug: drug || null, manufacturer: manufacturer || null, ndc: ndc || null },
      message: `No WAC increase disclosures matched drug=${drug || 'any'}, manufacturer=${manufacturer || 'any'}, ndc=${ndc || 'any'} across report years ${years[years.length - 1]}-${years[0]}.`,
    };
  }
  return {
    publisher: PUBLISHER,
    count: total,
    returned: rows.length,
    years_searched: years,
    data_as_of: new Date().toISOString().slice(0, 10),
    records: rows,
  };
}

async function wacFiveYearHistory(args: Record<string, unknown>) {
  const ndcRaw = typeof args.ndc === 'string' ? args.ndc.trim() : '';
  const ndc = ndcRaw.replace(/\D/g, '');
  if (!ndc) return { error: 'provide `ndc` (National Drug Code)' };
  const limit = clamp(args.limit, 50, 200);
  const maps = await resolveResources();
  const years = yearsToSearch(maps.wac5yr, args.year);
  const currentYear = String(new Date().getUTCFullYear());

  const perYear = await Promise.all(
    years.map(async (year) => {
      const c = cols(year === currentYear);
      const where = [`${c.ndc}::text ILIKE ${sqlLit(`%${ndc}%`)}`];
      try {
        const records = await sqlSearch(maps.wac5yr[year], where, 500);
        return records.map((r) => normalizeWac5yr(r, year));
      } catch {
        return [];
      }
    })
  );
  let rows = perYear.flat().filter((r) => r.ndc.replace(/\D/g, '').includes(ndc));
  rows.sort((a, b) => (b.history_effective_date ?? '').localeCompare(a.history_effective_date ?? ''));
  const total = rows.length;
  rows = rows.slice(0, limit);

  if (total === 0) {
    return {
      publisher: PUBLISHER,
      count: 0,
      years_searched: years,
      filters_tried: { ndc: ndcRaw },
      message: `No 5-year WAC history found for NDC ${ndcRaw} across report years ${years[years.length - 1]}-${years[0]}. This NDC may never have had a reported WAC increase, or the NDC format may not match HCAI's filing.`,
    };
  }
  return {
    publisher: PUBLISHER,
    ndc: ndcRaw,
    manufacturer: rows[0]?.manufacturer ?? null,
    count: total,
    returned: rows.length,
    years_searched: years,
    data_as_of: new Date().toISOString().slice(0, 10),
    history: rows,
  };
}

async function newDrugLaunchSearch(args: Record<string, unknown>) {
  const drug = typeof args.drug === 'string' ? args.drug.trim() : '';
  const manufacturer = typeof args.manufacturer === 'string' ? args.manufacturer.trim() : '';
  const limit = clamp(args.limit, 25, 100);
  const maps = await resolveResources();
  const years = yearsToSearch(maps.newdrug, args.year);
  const currentYear = String(new Date().getUTCFullYear());

  const perYear = await Promise.all(
    years.map(async (year) => {
      const isCurrent = year === currentYear;
      const c = cols(isCurrent);
      const where: string[] = [];
      if (drug) where.push(`${c.drug} ILIKE ${sqlLit(`%${drug}%`)}`);
      if (manufacturer) where.push(`${c.manufacturer} ILIKE ${sqlLit(`%${manufacturer}%`)}`);
      try {
        const records = await sqlSearch(maps.newdrug[year], where, 500);
        return records.map((r) => normalizeNewDrug(r, year, isCurrent));
      } catch {
        return [];
      }
    })
  );
  let rows = perYear.flat();
  rows.sort((a, b) => (b.introduced_to_market_date ?? '').localeCompare(a.introduced_to_market_date ?? ''));
  const total = rows.length;
  rows = rows.slice(0, limit);

  if (total === 0) {
    return {
      publisher: PUBLISHER,
      count: 0,
      years_searched: years,
      filters_tried: { drug: drug || null, manufacturer: manufacturer || null },
      message: `No new-drug launch-price disclosures matched drug=${drug || 'any'}, manufacturer=${manufacturer || 'any'} across report years ${years[years.length - 1]}-${years[0]}.`,
    };
  }
  return {
    publisher: PUBLISHER,
    count: total,
    returned: rows.length,
    years_searched: years,
    data_as_of: new Date().toISOString().slice(0, 10),
    records: rows,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ca_rx_wac_increases':
      return wacIncreaseSearch(args);
    case 'ca_rx_wac_five_year_history':
      return wacFiveYearHistory(args);
    case 'ca_rx_new_drug_launches':
      return newDrugLaunchSearch(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
