# Changelog

## [Unreleased]

## [0.8.2] - 2026-08-12

### Fixed
- **2026-08-12:** `ee_write`'s handler silently re-truncated any lesson over
  1500 chars to a bare `"..."`, even though the tool's own `inputSchema`
  advertises `maxLength: 4000` and `mcp/validate.js` already accepts up to
  4000 chars before the handler runs. The mismatch meant a caller who checked
  the schema and stayed under 4000 chars could still lose everything past
  char 1500, with no error, no annotation, and no field telling them it
  happened. Two long agent-authored lessons (Shipd false-positive-shape
  analysis) died mid-sentence this way and were unrecoverable from the brain
  alone — only recoverable because the source markdown still existed on disk.
  The handler now honors the already-validated 4000-char limit; if a further
  cut is ever needed it is annotated (`[…truncated N chars…]`) and the tool
  result carries `truncated: true, originalLength` so the caller can split
  the remainder into a linked follow-up entry instead of losing it silently.
  Live-brain repair (not part of this code change, run directly against
  Qdrant): 2 truncated entries recovered in full from their source memory
  file; 16 more found truncated by the same bug with no recoverable source,
  annotated as unrecoverable rather than left as a bare `"..."`; 16
  mis-scoped Shipd/Olympus entries retagged from `workspaces-ecosystems` /
  `muonroi-cli` to `shipd-challenges` for consistent recall ranking.

## [0.8.1] - 2026-07-17

### Fixed
- **2026-07-17:** Two producers were inventing project slugs no caller ever
  derives. This is not cosmetic: `applyScopeFilter` drops a passive hint "when
  both sides carry a project_slug AND they differ", so an entry labelled
  `c:/users` was invisible to hints for EVERY project, including the one it came
  from. (Active recall is unaffected — `recallMode` skips the project gate and
  honors only learned exclusions.)
  1. `memory-import`: `dirSlugToRealPath` returns a best-effort path even when
     nothing on disk matches, so `extractProjectSlug` ran over a non-existent
     path and produced a canonical-*looking* answer
     (`D--sources-eBerth-planner-new` → `planner`). Only a resolvable path may
     name a project; an unresolvable slug that encodes a path is global, and only
     a bare single-name dir may name itself.
  2. The session extractor stored `extractProjectSlug`'s output verbatim — but
     that function answers with a PATH-LIKE value from its two-segment fallback
     (`c:/users`, `d:/personal`, `e:/tiennv`) when it cannot resolve a repo root.
     That is an "unresolved" signal, not a name; it is now gated as
     `memory-import` already gated it.
  `isCanonicalProjectSlug` moves to `utils.js` as the single definition, beside
  the fallback that produces the values it rejects — two producers writing the
  same field must not disagree about what a slug is.
- **2026-07-17:** `ee_projects` / `ee_query` descriptions claimed a wrong
  `project` slug "silently drops the project-scoped entries you wanted". That is
  false for active recall, which is semantic and cross-repo by design: a wrong
  slug costs ranking and learned exclusions, not coverage. It is true for passive
  hints, which is where `ee_write`'s slug choice actually bites.

### Added
- **2026-07-17:** `scope.project_source` — the raw memory dir name, kept even
  (especially) when no slug could be derived from it. Every resolver is lossy:
  `D--sources-eBerth-planner-new` is `eberth-planner` to a reader and
  `planner`/`new` to every heuristic. Refusing to guess must not also discard the
  evidence — `project_slug: null` + `project_source` means "not known YET" and
  stays repairable by a later pass or an agent that can simply read the path.
  Inert to `applyScopeFilter`.
- **2026-07-17:** `tools/exp-repair-slugs.js` — re-labels what the bugs already
  wrote. Dry-run by default; cannot delete. Applied to the live brain: 104 points
  re-labelled, 0 deleted, 557 unchanged in count — 88 unscoped (global 147→235)
  and 16 `new` → `eberth-planner` (13→29). Patches the flat `scope_project_slug`
  AND the nested copy `applyScopeFilter` actually reads, keeps the old label as
  `scope.project_repaired_from`, and reports ambiguous slugs instead of guessing
  or silently skipping them.

## [0.8.0] - 2026-07-17

### Added
- **2026-07-17:** `GET /api/projects` + the `ee_projects` MCP tool — the slug
  directory, so `project` is PICKED rather than invented. Every ee_query/ee_write
  caller has to put something in `project`, and nothing told it what was valid.
  Guessing is not harmless: measured on the live brain, 30 distinct slugs exist
  across the three recall collections and roughly a third are canonicalization
  debris from whatever cwd wrote the entry — `.gemini` (20), `e:/tiennv` (19),
  `d:/personal` (18), `c:/users` (10), `new` (16), `tmp`, `any`, `core` sit
  alongside `muonroi-cli` (116), `storyflow` (36), `storyflow_ui` (22) and
  `experience-engine` (21). The slug an agent would invent from its repo name and
  the slug that matches stored entries are routinely different strings, and a
  miss does not error — it silently drops exactly the project-scoped entries the
  caller wanted, which is indistinguishable from a brain that knows nothing.
  Read-token gated, 5-minute cache, and it reports `truncated` / `failed` rather
  than passing a partial directory off as complete (a short list that looks
  authoritative teaches the agent its repo has no slug).
  Aggregates the FLAT top-level `scope_project_slug`: the nested
  `experience.scope.project_slug` lives inside the opaque `json` payload string,
  is invisible to Qdrant filters, and aggregating it reports zero slugs against a
  brain that has thirty.

### Changed
- **2026-07-17:** `ee_query` and `ee_write` now tell the caller to take `project`
  from `ee_projects` verbatim, and say what an unmatched slug actually does
  (silently narrows, never errors) and that omitting it widens rather than empties
  the recall.

## [0.7.1] - 2026-07-17

### Fixed
- **2026-07-17:** `ee_query` charged feedback debt for entries the agent was
  never shown. The ledger recorded every entry the brain returned, while the
  rendered index is truncated from the tail at `maxChars` (default 6000 against
  a recall that routinely renders ~30k chars). Verified live against the hosted
  brain: one `ee_query` returned 24 entries / 29779 chars, rendered 1166 chars
  with **zero** `[id col]` handles visible (`format.js:191` appends the handle at
  the *end* of each entry), and the next `ee_query` demanded a verdict on all 24.
  Under `EXPERIENCE_RECALL_FEEDBACK_GATE=hard` that unsettleable debt refuses the
  next recall outright. Debt is now charged only for handles that survived into
  the rendered text (`ee-api.js` `visibleEntries`), which is the only honest
  record of what the agent could see well enough to rate.

### Changed
- **2026-07-17:** The `ee_*` tool descriptions are the ONLY thing teaching a
  foreign agent how to use the brain — a client registering `exp-mcp` has no
  CLAUDE.md — so the parts that were load-bearing-by-omission are now spelled
  out. `ee_feedback` listed the four noise reasons as a bare enum with no
  semantics, which invites defaulting to `wrong_task`: the one reason that
  preserves nothing and permanently deletes an entry that may have been valid for
  every other repo and language. It now carries the ordered decision tree and
  says which reasons narrow scope (entry survives) versus delete. `ee_health`
  explains `status:0` (no response at all) versus a real HTTP status (401 auth,
  429 back off). `ee_query` states that an omitted `project` derives scope from
  the *server process's* cwd — wrong for a globally-registered server — and that
  the default `maxChars` shows roughly the strongest fifth of a broad recall.

## [0.7.0] - 2026-07-17

### Added
- **2026-07-17:** `exp-mcp` — an MCP server that serves the brain to any MCP
  client directly (`npm i -g @muonroi/experience-engine` then `claude mcp add
  experience-engine -- exp-mcp`). The `ee_*` tools previously lived in
  muonroi-cli, so reaching the brain over MCP meant installing a whole CLI you
  had no other use for. Four tools: `ee_query` (active recall), `ee_feedback`
  (rate an entry), `ee_write` (record a lesson), `ee_health`. No
  `@modelcontextprotocol/sdk` and no zod — the package stays
  zero-runtime-dependency, with `mcp/server.js` as the JSON-RPC loop and
  `mcp/validate.js` as a JSON-Schema-subset validator. `ee_query`/`ee_feedback`
  delegate to `exp-recall.js` / `exp-feedback.js` rather than re-implementing
  transport, so they resolve the hosted brain from `~/.experience/config.json`
  on thin clients and still mirror recalls into the local `activity.jsonl`.
  Recall output is capped for the MCP per-result token limit: a verified live
  `ee_query` returned 22 entries / 30189 chars, capped to 597.
- **2026-07-11:** `POST /api/workflow-event` — a write-during-execution channel
  that upserts a NEW point into `workflow_{debate,sprint,decision,mistake}` with
  `tier:"intra-session"`, for persisting experience mid-run rather than only
  reinforcing existing points at phase end. Disabled by default (404) unless
  `ENABLE_WORKFLOW_EVENT=1` or `enableWorkflowEvent` is set. The `workflow_*`
  collections are deliberately kept OUT of the recall hot path — the endpoint
  queries them directly — so the change cannot destabilize recall.
- **2026-07-11:** Per-stance collection weighting in recall. `handleRecall` now
  accepts optional `stance`/`role` (non-breaking) and `normalizeSourceMeta` no
  longer strips them, so each stance scales the `[principles, behavioral,
  selfqa]` collections by its affinity before the cross-collection merge — a
  researcher sees more principles, an implementer more behavioral how-to, a
  verifier more self-QA. A weight of 0 deselects a collection outright; an
  unknown or default stance yields `[1,1,1]`, a strict no-op.
- **2026-07-05:** `brainExtract{Provider,Endpoint,Key}` config — the extract and
  evolve path can now run on a different provider, endpoint, and key than the
  hot-path brain, and `/api/brain` honours `useExtractModel` to route there.
  This exists because SiliconFlow rate-limits DeepSeek-V3 hard (HTTP 429, code
  50609 "System is too busy"), which silently null-ed every who-am-i and
  style-extract call. Each getter falls back to its hot-path equivalent when
  unset, so single-provider installs are unchanged and explicit caller
  `options.*` still win.
- **2026-06-30:** Prompt-injection filter on rendered hints
  (`src/security-filter.js`). `format.js` now drops any stored point whose
  payload matches a known injection pattern (`ignore … instructions`, `system
  prompt`, `assistant:`/`user:` role prefixes, and similar) and logs
  `security_filter_blocked_point`, so a poisoned experience cannot be rendered
  into an agent's context.
- **2026-06-21:** Hybrid dense+sparse retrieval on `/api/search` (was
  dense-only, so it buried experiences matching on exact terms but sitting far
  from the query embedding). `searchCollectionHybrid()` runs the dense cosine
  leg and a lexical leg (native BM25 sparse when the collection is
  sparse-migrated, else boolean `MatchText`) and fuses them with Reciprocal Rank
  Fusion (`RRF_K=60`), reusing the same `_fusion.hybridFuse` recall already
  applies. On by default; `EXPERIENCE_SEARCH_HYBRID` / `searchHybrid` reverts to
  dense-only without a redeploy. Fail-open by design — any unexpected throw
  returns the dense leg untouched, so hybrid can never regress dense-only
  behaviour.
- **2026-06-21:** `/api/pil-context` returns the Qdrant point `id` and source
  `collection` on each `t0_principles` / `t2_patterns` item, so passively
  injected points are rateable via `ee_feedback(id, collection, verdict)` —
  previously `toScoredText` dropped both, leaving the feedback loop half-open on
  that path (the negative prompt-stale arm still decayed those points, but
  nothing could credit them). `schema_version` 1.0 → 1.1; additive and backward
  compatible, so older clients strip the unknown fields and older servers still
  parse.
- **2026-06-19:** "Who Am I" v4.0 — the on-device profile is now consumed, not
  just written. `profile.yaml` was written by the Stop hook but read by nothing
  except the viewer; the SessionStart hook now renders and injects it via a pure
  `src/profile-render.js`, entirely on-device. Injection re-filters per
  dimension against the LIVE privacy level (`off`=none, `minimal`=Tier 1,
  `standard`/`full`=+Tier 2, with a namespace guard), composed fresh each session
  so a profile edit or privacy-off takes effect next session, and fails open to
  brief-only rather than dropping the injection. Two new signals ship with it:
  `work_patterns.session_length` (per-session voting bucketed
  short/medium/long) and `work_patterns.delegation_style`
  (autonomous/collaborative, Vietnamese + English).

### Changed
- **2026-07-17:** The rate limiter keys on caller identity instead of the
  proxy's IP. Every bucket used `req.socket.remoteAddress` with a flat 120/min,
  but behind the reverse proxy that is not a per-client limit at all — Apache
  reverse-proxies to `127.0.0.1:8082`, so EVERY agent on EVERY machine arrived
  as `127.0.0.1` and shared ONE 120/min bucket, a fleet-wide throughput ceiling
  on authenticated callers while an anonymous attacker got the same 120. Now: a
  valid token gets a per-token bucket capped at `server.rateLimit` (default
  6000/min, a runaway backstop rather than a quota); no token gets a per-IP
  bucket capped at `server.rateLimitAnon` (default 120/min); an install with no
  `authToken` configured is treated as trusted. `X-Forwarded-For` is honoured
  ONLY from a loopback peer — trusting it from a direct peer would let one
  attacker mint a fresh bucket per request and bypass the limiter entirely. An
  explicit `rateLimit: 0` now really disables the limit — the old `|| 120`
  silently turned "disabled" into 120/min, the opposite of the operator's
  intent.
- **2026-07-17:** Active recall no longer pays for `brainRelevanceFilter`. Once
  the filter ran for the first time in ~8 weeks (see Fixed), its real cost and
  value became measurable: it fired on 8/8 recalls at p50 ~2.5s, taking recall
  p50 from 1508ms to 4203ms, and removed 0 hints in 8/8. That is structural, not
  sampling — `recallMode` bypasses the search-score floor so a recall always has
  lines and always burns a call, and the filter's prompt is framed for passive
  hints ("avoid a mistake for THIS action") while telling itself to INCLUDE when
  unsure. Passive hints keep the gate, where it stays nearly free (6/6 sampled
  intercepts produced 0 lines, so the filter never runs). `/api/recall` p50
  returns to ~1.5-2.0s.
- **2026-07-01:** `setup.sh` is now a v4 router (thin client, Docker, init,
  upgrade) and the default install path is the thin client. The legacy
  ~2000-line full-local embed/brain/Qdrant wizard moves to `setup-full.sh`,
  reachable with `--full`.

### Fixed
- **2026-07-17:** `brainRelevanceFilter` had thrown on EVERY call for ~8 weeks
  and nobody noticed, because a bare catch ate the error and the response looked
  identical either way. A commit that removed debug logs deleted the line that
  also declared `rawAction`, leaving the reference on the next line, so every
  call threw `ReferenceError: rawAction is not defined` straight into `catch {}`.
  Proved on production by instrumenting the catch, and corroborated by
  `activity.jsonl`, which contains not one `cost-call kind=brain
  source=brain-filter` row across its entire history despite `brain-llm.js`
  logging one unconditionally per completed call. The declaration is restored
  and wrapped in `String()`, and both bare catches now log — a dead filter and a
  filter that keeps everything are indistinguishable from the outside, so a log
  line is the only way this surfaces.
- **2026-07-17:** Recall blocked the event loop for seconds per request, so a
  few concurrent recalls starved the single-threaded server and clients saw
  `[ee_unavailable]` with `ee_health {"ok":false,"status":0}`. Three defects,
  each measured on production: (1) `storeRouteDecision` did an unconditional
  FileStore dual-write, and since `fileStoreUpsert` is a read-modify-write of
  the ENTIRE collection with a fresh UUID per call, the file grew without bound
  and every request paid O(filesize) — `experience-routes.json` had reached
  307MB / 10937 entries, one `/api/recall` read 310MB and wrote 307MB, and
  `readFileSync` + `JSON.parse` of that file alone timed at 3121ms; (2)
  `getEdgesForId` re-read and re-parsed the whole edge store on every call,
  ~90 times per recall at 28.8ms each (2.57MB / 6534 edges) = ~2.6s of
  uninterrupted blocking, now served from a stat-keyed Map index; (3)
  `searchCollection` caught the caller's AbortSignal along with real connection
  errors and fell back to a whole-file read plus an in-JS cosine scan, making a
  slow brain worse — abort now degrades to empty, and the FileStore path stays
  reserved for a genuinely unreachable Qdrant. `routeFeedback` carried the same
  read-modify-write defect, undetected only because nothing calls it; it is now
  gated on Qdrant too. Recall p50 is ~1.5-2.0s with no event-loop block.
- **2026-07-09:** The sensitive-keyword risk gate used a raw substring match, so
  short alphabetic keywords fired constantly on unrelated text — `auth` matched
  the `Co-Authored-By` trailer present in EVERY commit message, `prod` matched
  "reproduce"/"product", `cors` matched "scores", `token` matched "tokenizer".
  Every git commit tripped the gate. Pure single-word alphabetic keywords now
  match on word boundaries; multi-word and symbol keywords (`rate limit`,
  `rm -rf`, `force-push`, `reset --hard`) keep substring semantics.
- **2026-07-06:** Offline queue head-of-line poison blocking — the queue grew to
  ~2900 stuck events on a healthy client with the server reachable.
  `interceptor-post.js` POSTed PostToolUse events with an empty `toolName`
  (codex/antigravity payloads carrying no tool name), which `/api/posttool`
  rejects 400, and the catch queued the rejection as permanent poison; because
  `flushQueue` broke on ANY error, the 2 oldest poison records froze all valid
  events behind them (one hit 15,314 attempts while 2,675 valid events never
  drained). The POST is now skipped entirely when `toolName` is empty, and
  `flushQueue` quarantines permanent 4xx (all except 429/408) and continues past
  them; transient errors keep break-and-backoff.
- **2026-07-05:** Session extraction ran up to 10 sequential `extractQA` calls
  (~9s each on the slow extract model) synchronously on the request, so any
  client with a short deadline (muonroi-cli's 2s on cli-exit) aborted and
  nothing was ever learned. `handleExtract` now ACKs immediately and runs
  extraction + consolidation in the background on the long-lived server, and
  surviving experiences process with bounded concurrency (4) instead of a fully
  sequential loop — `N*~9s` wall time becomes `ceil(N/4)*~9s`.
- **2026-07-01:** Credential exposure in the thin-client path.
  `setup-thin-client.sh` shipped a hardcoded server URL and tokens, so an
  upgrade exposed them; it now reuses `~/.experience/config.json`, gains an
  `--upgrade` mode, and requires user input on a fresh install. Built-in server
  defaults are dropped from `ssh_tunnel_manager.js`, and `health-check` output
  redacts IPs and raw URLs from check details, suggested fixes, and gate paths
  (HTTP 000 is now reported as "unreachable" rather than exposing the
  connection target).
- **2026-07-01:** Hook registration across agents. `register-hooks` skipped
  muonroi-cli on upgrade even when `~/.muonroi-cli/user-settings.json` existed
  (a present settings file now counts as opt-in, and the health check is skipped
  when the CLI is absent), and Antigravity hooks needed a set of fixes to
  register at all: the global hooks path moved to `~/.gemini/config/hooks.json`,
  registration now covers both the CLI and the IDE, the `toolCall` wrapper
  schema is accepted, a wildcard `*` matcher is used, `run_command` matches in
  `interceptor.js`, and the health check verifies the result.
- **2026-06-23:** `/api/brain` dropped classification options — `handleBrainProxy`
  now forwards `systemPrompt`, `responseFormat`, `model`, `maxTokens`, and
  `provider` through to `classifyViaBrain`, so callers can request JSON output
  and override the model tier.
- **2026-06-21:** Two hybrid-retrieval correctness bugs. `syncToQdrant` upserted
  points dense-only and never computed the `text_bm25` sparse vector, so
  anything written after a sparse migration silently drifted out of
  hybrid-retrieval coverage for both `/api/recall` and `/api/search` — on
  production, `experience-selfqa` had 104/446 points (~23%) missing `text_bm25`.
  Writes now derive the lexical text and upsert the named-vector shape, falling
  back to dense-only (logged at warn) on token-less text or a build error so a
  write is never blocked, and staying dense-only on pre-migration installs.
  Separately, `searchCollectionHybrid` returned the full fused list rather than
  slicing it, so `/api/search` returned up to 2×`limit` results for a `limit=N`
  request — a broken limit contract and a token-thrift regression; the
  RRF-ordered fusion is now sliced back to `topK`.

## [0.6.0] - 2026-06-19

### Added
- **2026-06-19:** `experience-engine check-update` and `experience-engine update`
  commands. `check-update` compares the installed package version against the npm
  registry `dist-tags.latest` and exits `0` (up to date) / `10` (update available)
  / `1` (check failed) — no side effects, script-friendly. `update` runs the check
  then updates in place, auto-detecting the install mode: a git checkout delegates
  to `bash upgrade.sh`; a plain npm install runs `npm i -g
  @muonroi/experience-engine@latest` and refreshes `~/.experience` via `init --yes`
  (no bash on the npm path, so it works natively on Windows). `--force` re-runs the
  updater even when already current.

## [0.5.1] - 2026-06-19

### Fixed
- **2026-06-19:** Injected agent-instruction block (`agent-md.js` /
  `inject-agent-instructions.sh`) and `AGENT_GUIDE.md` taught the feedback API as
  `http://localhost:8082`, which is wrong for thin-client installs that hit the
  hosted brain at `https://experience.muonroi.com`. The guidance now says the
  helper resolves the brain URL + token from `~/.experience/config.json` (hosted
  domain on thin clients, `localhost:8082` only for a local full brain) and to
  never hand-roll a raw `curl` to a hardcoded endpoint. Refreshes idempotently on
  the next install/upgrade.
- **2026-06-18:** Windows thin-client health-check false failures — `curl`
  Schannel `-w` exit 43 (now uses a node `fetch` probe) and a missing `grep`
  (now grep-free) — plus offline-queue growth where the PostToolUse POST (~3s)
  exceeded the 1.2s hook budget; replaced with a generalized detached drainer.
- **2026-06-18:** `inject-agent-instructions` tests failed on Windows because
  `execFileSync('bash', …)` resolved WSL bash (which cannot read `D:/` paths);
  the tests now resolve Git-bash explicitly and skip cleanly when it is absent.

## [0.5.0] - 2026-06-18

### Added
- **2026-06-18:** `config.ollamaEmbedModel` (env `EXPERIENCE_OLLAMA_EMBED_MODEL`)
  — opt-in knob for the cross-provider Ollama embedding fallback. Empty by
  default, so the fallback is OFF unless explicitly pointed at an Ollama-pulled
  model whose dimension matches `embedDim` (see Fixed below).
- **2026-06-16:** `feedback` clients (`exp-feedback.js`) attach `cwd` to the
  `/api/feedback` body so the server's `deriveCallerMeta()` can enrich
  lang/project for `noiseContextHistory` → evolution Step 3d scope-narrowing.

### Fixed
- **2026-06-18:** Service restart-storm on transient embedding outages. The
  health watchdog (`scripts/health-watch.sh`) restarted the node service on ANY
  `health-check.sh` failure — including a live embed-API timeout — but a restart
  cannot fix an upstream provider outage, so it thrashed (observed: 6 restarts in
  80 min, one `shutdown_timeout`) until the provider recovered. Now it restarts
  ONLY when `/health` is unreachable within 5s (a dead/wedged process — the one
  condition a restart fixes); embed/brain/Qdrant/network failures are logged +
  streak-alerted but not restarted. `systemd Restart=always` still covers crashes.
- **2026-06-18:** Unsafe cross-provider embedding fallback. `getEmbedding` fell
  back to Ollama reusing the primary's model name (e.g. SiliconFlow
  `Qwen/Qwen3-Embedding-0.6B`), which 404s in Ollama, and a different model emits
  vectors in an incompatible space / wrong dimension that silently poison Qdrant.
  The fallback is now opt-in (`ollamaEmbedModel`) and discards any vector whose
  length != `embedDim`. Native Ollama-primary setups are unaffected.
- **2026-06-16:** Dashboard `topOffenders` mislabelled seeds as offenders.
  Seed / `evolution-abstraction` entries surface broadly as context and never
  convert to a hit, so their `ignoreRatio` ~1.0 pinned them to the top of the
  list, burying genuinely-noisy organic entries. `computeTopOffenders` now
  excludes seeds; `indexQdrantPoints` carries `createdFrom`.
- **2026-06-15:** `exp-stats` reported `totalMistakes=0` / 0% extraction — it
  counted a nonexistent `mistakes` field instead of `experiences`, with an
  unguarded divide. Now reads the correct field and guards the ratio.
- **2026-06-15:** `exp-gates` Gate-1 brain-health false-RED (strict
  `result.test==='ok'` vs the model's actual reply) and a precision check that
  failed on tiny samples; added an insufficient-sample (`>= 20`) pending guard.
- **2026-06-15:** `inject-agent-instructions.sh` duplicated its managed block on
  every run on grep-less hosts (`grep -q` exited 127 → append branch). Now uses a
  pure-bash substring test — idempotent everywhere.
- **2026-06-15:** `surface-trigger` leaked an unref'd timeout timer + a pending
  promise per call (node 22 reds CI on the targeted-recall timeout test).

## [0.4.0] - 2026-06-15

### Added
- **2026-06-15:** `experience-engine sync` (`bin/sync.js`) — cross-platform,
  zero-bash port of `upgrade.sh`'s session-sync step. Feeds the brain from this
  machine's local agent history without a repo checkout or Git Bash:
  `bulk-extract.js` (sessions → `POST /api/extract`) + `import-memory.js`
  (curated `MEMORY.md` → `POST /api/import-memory`) + `.last-sync.json` marker.
  Flags: `--max` (default 30), `--max-age` (default 365d), `--runtime`,
  `--project`, `--sessions-only`, `--memory-only`, `--include-reference`,
  `--reset-marker`, `--upgrade` (refresh runtime via `init --yes` first),
  `--dry-run`, `-v`. Both tools are thin-client aware — they read
  `~/.experience/config.json` and POST to the configured remote brain.
- **2026-06-15:** `npx … init` now installs the sync tools and their verified
  dependency closure (`bulk-extract.js`, `import-memory.js` into
  `~/.experience/tools`; `src/{utils,query-builder,context,logger,memory-import}.js`
  added to `THIN_SAFE_SRC`). Previously these shipped only with full `setup.sh`,
  so an `npx`-installed thin client had no way to sync.

### Fixed
- **2026-06-15:** `import-memory.js` eagerly `require`d `src/evolution.js`
  (which pulls the entire local brain — embedding/qdrant/sparse/brain-llm).
  On a thin client `storeImportedExperience` is never called (transport=server),
  but the eager require crashed the tool at load on installs that ship only the
  thin runtime. Now lazy — loaded on first use in the direct-Qdrant branch only.
  Verified: both sync tools run `--dry-run` to exit 0 in a thin-only environment
  with `evolution.js` absent.

## [0.3.0] - 2026-06-15

### Added
- **2026-06-15:** `PostToolBatch` is now a first-class hook shipped across all
  install paths. `posttool-batch-hook.js` is published in the npm package
  (`files`), copied by `npx … init`, `setup-thin-client.sh`, and `setup.sh`, and
  wired by `register-hooks.js` via the optional `EXP_INTERCEPTOR_BATCH` env
  (Claude Code only; backward-compatible — skipped when unset). Previously the
  hook existed but reached only full `setup.sh` machines.

### Fixed
- **2026-06-15:** Windows libuv crash in `posttool-batch-hook.js`
  (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c:76`).
  `process.exit()` raced the undici keep-alive socket (and a pending stdin read)
  mid-teardown. Now sends `Connection: close`, reads stdin to natural `end` with
  an unref'd watchdog, and drains via `process.exitCode` instead of
  `process.exit()` on the main path — matching the sibling hooks and
  `remote-client.js`. Reproduced 3/3 before, 0 after.

## [0.2.0] - 2026-06-15

### Added
- **2026-06-15:** cross-platform `npx @muonroi/experience-engine init` installer
  (`bin/init.js`) — Node-native, no `bash`/Git Bash dependency, runs on Windows.
  Auto-detects a brain (local `:8082` → offer Docker → remote thin-client),
  installs the thin-client runtime, wires agent hooks via `register-hooks.js`,
  and injects the managed agent-instruction block (`.experience/src/agent-md.js`,
  a Node port of `inject-agent-instructions.sh`). README Quick Start now leads
  with `npx … init`; docker-compose demoted to "Self-host the brain (advanced)".
- **2026-05-13:** add `/api/pil-context` endpoint (PIL unified call;
  consolidates 5-6 brain round-trips into 1; 5-min LRU cache). Spec:
  `muonroi-cli/docs/superpowers/specs/2026-05-13-pil-unified-brain-endpoint-design.md`.

### Fixed
- **scope**: `applyScopeFilter` is now fail-closed for org-tagged points when
  no org is configured. Previously, the post-`1b184df` org-agnostic refactor
  meant legacy data tagged `scope.org=muonroi` (or any other org) leaked into
  every project that shared the Qdrant brain. Now: a point with `scope.org`
  is dropped unless the local install has `org.name` set OR opts in via
  `org.globalScope=true` in `~/.experience/config.json`.
  (`.experience/experience-core.js` applyScopeFilter)
- **scoring**: `hitBoost` is capped at `HIT_BOOST_MAX=0.12` and bypassed
  entirely for seed entries (`createdFrom: 'seed-…'`). Previously, an
  unbounded organic boost let a stale 100-hit 0.45-cosine entry overtake a
  fresh 0-hit seed at 0.85 cosine, inverting the seed-promote intent.
  (`.experience/src/scoring.js`)
- **scoring**: `computeEffectiveConfidence` bypasses `ageFactor` for seeds.
  Previously a 0.7-base seed with 0 hits fell to 0.49 and was filtered
  below `minConfidence` at display time, even when retrieval was perfect.
- **scoring**: seeds no longer take `projectPenalty`. They originate from
  org/common docs, not project files; `_projectSlug` is missing by design.
  Cross-repo leakage is already prevented by the new org-stack gate.
- **query**: `extractCodeSymbols` is bounded — hard cap at 8000 chars of
  input and 2000 regex iterations. Prevents pathological diffs (long runs
  of `IFooService` / similar identifiers) from blowing latency on the hot
  intercept path. (`.experience/src/utils.js`)
- **upgrade.sh**: requires `node` in `PATH` before invoking `node -e` for
  mode detection; previously a missing Node silently propagated `MODE=""`
  and hit a useless catch-all. Also rejects non-string `c.version`.

### Tests
- `.experience/test-scope-fixes.js` — seed bypass + extractCodeSymbols bound.
- `.experience/test-scoring.js` — NOISE-01 updated for `HIT_BOOST_MAX`.

### Breaking

- **Engine is now org-agnostic.** Removed all hardcoded references to a
  specific organization name (previously `muonroi`) and consumer-repo
  whitelist (`storyflow`, `quick-codex`, `experience-engine`). Cross-project
  hint filtering is now driven entirely by `~/.experience/config.json`:
  ```json
  { "org": { "name": "<your-org>", "repoPatterns": ["<extra-slug>", "prefix-*"] } }
  ```
  When `org` is absent the engine runs in **global mode** — every hint is
  eligible, no leak gate. To opt back into filtering, re-run `setup.sh` and
  answer the new **Step A.5 — Org Binding** prompt (or set `EXP_ORG_NAME` /
  `EXP_ORG_PATTERNS` for non-interactive mode).
- `utils.isMuonroiStackRepo()` / `utils.getMuonroiStackRepos()` removed.
  Replaced by `utils.isOrgStackRepo(filePath, orgConfig)`. Downstream callers
  outside this repo must update.
- The previous `seed-entries.jsonl` (org-doc sample seeded from the author's
  own stack) moved to `examples/seeds/org-doc.example.jsonl`. The universal
  `seed-common-principles.jsonl` at repo root is unchanged and still safe to
  ingest as-is.

### Migration

Existing users running on the old hardcoded gate keep working without action:
just add an `org` block to your `~/.experience/config.json` when convenient
(or re-run `setup.sh` — your other settings are preserved). Without it, the
engine surfaces every hint instead of dropping org-tagged ones in foreign
repos.

## [0.1.1] - 2026-05-05

### Features

- OpenAPI spec, config encryption at rest (G10 + G20) (8ebc96e)
- rate limiting, /metrics endpoint, enhanced health with alerting (ecb60ee)
- embed inline feedback API in hint output (8212640)
- context-aware brain routing + Qwen3-14B + role constraint (2ac0285)
- **06-02:** add /api/search endpoint to experience-engine server.js (PIL-02 cross-repo) (88ff403)

### Bug Fixes

- metrics endpoint always emits 24h counters even without activity.jsonl (d980147)
- sync-install.sh and setup-thin-client.sh copy src/ modules (a9c1615)
- resolve 3 breaking issues from modular refactor (495088a)
- align src/qdrant.js with core behavior + add delegate (01a8d43)
- align src/embedding.js with core behavior + full delegate (481cd51)
- align src/utils.js with core behavior (verbatim extract) (a4753d2)
- embed resilience, evolution stability, data lifecycle, precision filtering (0dedc6c)
- update tests for brain-delegated classification + improve TASK_ROUTE_PROMPT (a66784c)
- rewrite CLASSIFY_PROMPT for Qwen3 few-shot format (85aa60f)
- improve CLASSIFY_PROMPT to bias toward fast tier (48142cd)
- rewrite CLASSIFY_PROMPT for language-agnostic tier detection (c191b0d)
- repair multiline string literal in error_fix detection (c34542b)
- **quick-01:** lower abstraction cosine threshold and min cluster size, deploy (d484a1f)
- **quick-01:** strengthen project-scope filter and tighten error_fix detection (48d04a7)

### Refactoring

- slim core from 3553 to 1909 LOC (-46%) (1af20fb)
- remove ~600 LOC duplicate function bodies from core (Group C) (662a963)
- extract evolution.js, router.js + add SELFQA_COLLECTION, setQdrantAvailable (4c6262f)
- extract brain-llm.js, format.js, graph.js (1c19c2d)
- extract src/noise.js (6a095d6)
- extract src/scoring.js (3e1a9d7)
- extract src/context.js (420f403)
- extract src/session.js (c1a389c)
- delegate ~40 functions from experience-core.js to extracted modules (1e20aa7)
- extract shared utility functions from experience-core.js (c8ee0f0)
- extract qdrant I/O module from experience-core.js (2c0ced4)
- extract config and embedding modules from experience-core.js (3c9abe5)
- remove hardcoded keyword classifiers, delegate to brain (1226b16)

### Documentation

- update PLAN.md with v2 refactoring plan (c944e80)
- **quick-260501-rqc:** Fix EE v3 tuning: project-scope filter, error_fix detection, abstraction threshold (ee32bf5)
- **quick-01:** complete 260501-rqc EE v3 tuning plan summary (ccfffce)

### Tests

- add P0 test coverage for intercept, embedding, and qdrant-io modules (23432b1)

### Chores

- add ESLint, Prettier, Docker publish, Python SDK CI, changelog script (bfb4dbe)

