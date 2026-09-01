# Poke v1 completion and CLI rebuild

## Goal

Make the repository satisfy `POKE.md` as the product contract, with a polished blue interactive CLI, working WhatsApp pairing and re-authentication, correct pi-ai provider authentication, durable runtime behavior, current integrations, and a clean supported installation.

This plan treats “complete” as: no known mismatch with `POKE.md`, every acceptance behavior in section 23 is either automated or exercised by the VPS smoke test, supported clean installs have no unresolved production vulnerability or unreviewed install script, and the section 24 definition of done passes. It does not use a green unit suite as a substitute for those outcomes.

## Verified baseline

The existing 77 tests and TypeScript check pass, but they do not cover the broken public flows. The main defects are structural:

- `src/cli/setup.ts`, `login.ts`, `model.ts`, and `whatsapp.ts` each implement raw numbered readline flows. Setup asks for the owner first and never pairs WhatsApp. Re-authentication is a placeholder.
- `src/cli/login.ts` treats a Codex OAuth access token as an API key, fabricates an expiry, and can save invalid replacement credentials.
- `src/providers/codex.ts` uses a stale hardcoded model list and the OpenAI API-key models endpoint. `provider-registry.ts` passes a ChatGPT token as `OPENAI_API_KEY` instead of using pi-ai's refreshable OAuth path.
- `src/gateway/whatsapp.ts` receives Baileys QR events but exposes them only in memory/logs. It has no phone-number pairing-code path or safe credential replacement transaction.
- `src/cli/status.ts` infers connection from auth files instead of live state. `doctor.ts` mutates state and performs mostly presence checks, so it is not the specified read-only diagnostic.
- `src/agent/runtime.ts` has silent model defaults, incomplete environment propagation, approximate compaction bookkeeping, and dispatch crash windows. Several `POKE.md` acceptance behaviors are absent or only shallowly mocked.
- Supermemory, Deepgram Flux, Composio, and Flue skill integration do not match their current contracts. The legacy `composio-core` dependency is the source of all seven current audit findings.
- Flue imports Node's `node:sqlite`. The repeating experimental warning is runtime-version dependent and must be removed by defining and enforcing a warning-free supported Node baseline, not by globally suppressing warnings.
- A clean `npm ci` reports deprecated packages and unreviewed dependency install scripts. The lockfile and installation policy are not release-ready.

## Product invariants

These constraints guide every phase:

1. `POKE.md` is authoritative. Remove or replace behavior that conflicts with it instead of preserving accidental compatibility.
2. There is one main Flue conversation with the stable instance ID `owner`. WhatsApp events, worker completions, and automations enter that conversation through durable, idempotent dispatches.
3. WhatsApp credentials, provider credentials, config, SQLite state, and delivery state survive daemon restarts. Secret files are mode `0600`, written atomically, never logged, and never exposed to the sandbox unless the product explicitly requires it.
4. Pairing and credential replacement are transactions. A cancelled or failed replacement keeps the previously working session or provider credential.
5. The live account catalog decides model availability. Capability metadata decides reasoning options. Poke never invents reasoning levels and never silently falls back to another provider or model.
6. The daemon is the sole owner of the live gateway and runtime. CLI maintenance commands coordinate with it instead of opening a second socket or modifying files underneath it.
7. Tests assert public behavior through the CLI, gateway, daemon, database, and provider seams. Private call-order tests are not the completion signal.

## Phase 1: supported runtime and clean dependency baseline

Establish a trustworthy installation before building more behavior on it.

- In `package.json`, installation docs, and lifecycle preflight, set one supported Node 24 LTS minimum that has been verified not to emit the `node:sqlite` experimental warning with the installed Flue version. Add `engines` and a startup error that reports the detected and required versions.
- Exercise `poke`, the daemon, and the systemd unit under that exact minimum version. Do not add `--no-warnings` or `NODE_NO_WARNINGS`. If Flue still emits the warning at the supported minimum, replace only its persistence adapter with Flue's supported libSQL/local SQLite adapter and retain the same Poke database location.
- Upgrade `@earendil-works/pi-ai` to the newest compatible release after compiling against its installed types. Upgrade other direct dependencies only when required by the migrations below.
- Replace deprecated `composio-core` with current `@composio/core`; delete the legacy package and adapters after the new integration passes.
- Run `npm audit` before and after dependency changes. Remove the current `tmp`, `external-editor`, `inquirer`, and vulnerable `uuid` chain with the Composio migration. Do not accept a downgrade suggested by `npm audit fix` if it restores an obsolete SDK.
- Review each package install script. Commit npm's version-pinned `allowScripts` policy, approving only scripts needed for Baileys compatibility checks, the SQLite native binary, esbuild, and any dependency proven to require one. Deny no-op scripts after verifying clean install, build, and runtime behavior.
- Regenerate `package-lock.json` with the repository's documented npm version. Add CI gates for a fresh `npm ci`, no unreviewed install scripts, no known production vulnerabilities, build, typecheck, and test.
- Track any unavoidable upstream-only deprecation separately with package, owner, and removal condition. A direct deprecated dependency or high/moderate production vulnerability blocks release.

Acceptance:

- A fresh supported Ubuntu/Node environment produces one clean, deterministic installation with no recurring SQLite warning.
- `npm audit --omit=dev` has zero known vulnerabilities; the full audit has no untriaged findings.
- The systemd daemon and interactive CLI use the same supported Node binary.

## Phase 2: one interactive CLI system

Replace the separate readline implementations with one testable interaction boundary.

- Add a small `src/cli/ui.ts` adapter around an established prompt library such as `@inquirer/prompts`, after checking the installed version's theming and cancellation API. Expose select, confirm, text, secret, spinner/progress, note, success, warning, and error primitives.
- Define one blue palette. Select menus use arrow keys, visible radio/circle state, and Enter. Secrets are masked. Current values and completion state are visible without printing credentials.
- Respect `NO_COLOR`, non-TTY output, narrow terminals, Ctrl+C, EOF, and terminal restoration. Blue is presentation, not semantic information required to understand an error.
- Replace `src/cli/prompt.ts` and all numeric menus in setup, login, model, and WhatsApp. Invalid input stays at the current step and preserves already completed work.
- Give every long external action a spinner and final result: pairing, key validation, OAuth polling, live catalog fetch, daemon transition, and diagnostics.
- Keep the section 19 command set only. Remove the extra `poke service` surface; systemd installation remains an implementation detail of lifecycle commands.
- Make `poke help` and each command's `--help` concise and consistent. Non-interactive status, doctor, and logs stay pipe-friendly and omit ANSI when stdout is not a TTY.

Tests:

- Add pseudo-terminal tests that drive arrow keys and Enter, assert radio selection and blue TTY rendering, and verify `NO_COLOR`/piped output.
- Cover cancellation at every destructive or credential-changing prompt, validation retry, terminal cleanup, and secret redaction.
- Stop testing raw readline internals. Inject the UI adapter and assert observable command results.

## Phase 3: WhatsApp-first setup and safe session management

Create one pairing service shared by `poke setup` and `poke whatsapp`.

- Extract Baileys connection ownership from `src/gateway/whatsapp.ts` into a `WhatsAppPairingService` plus the runtime gateway. The service supports:
  - QR pairing, rendered legibly in the terminal from Baileys QR updates.
  - Phone-number pairing using `requestPairingCode`, with country code validation, normalized digits, a clearly formatted code, and status while waiting.
  - A bounded timeout, user cancellation, Baileys close-reason translation, and waiting for an actual `connection=open` before reporting success.
- Pair into a sibling staging auth directory. On success, close the pairing socket and atomically replace `~/.poke/whatsapp`; on timeout, cancellation, or failure, delete staging and leave the old session untouched.
- When re-authenticating, gracefully stop a running daemon before opening the staging socket. Restart it after a successful swap. On failure, restart with the preserved old session. Never let two sockets use the same auth state.
- Derive and display the connected Poke WhatsApp account from the authenticated session. Store only non-secret normalized account metadata in config/runtime status.
- Rebuild `poke setup` as a resumable state machine in the exact product order:
  1. Pair Poke's WhatsApp by QR or phone pairing code.
  2. Collect and E.164-validate the personal owner number; reject the paired Poke account itself.
  3. Collect and validate Composio, Supermemory, Exa, and Deepgram keys with cheap read-only calls.
  4. Show completion and the next commands, `poke login`, `poke model`, and `poke model worker`.
- Persist each successful step atomically so a failed service check or Ctrl+C does not erase pairing or earlier valid keys. Hardcode `TZ=Asia/Karachi`; do not ask for it or for AI-provider credentials.
- Rebuild `poke whatsapp` in the specified order: Re-authenticate, Clear session, Show connection status, Cancel. Status comes from daemon/gateway state, not file count.
- Require explicit confirmation before clearing. Stop the daemon, close the gateway, and remove only WhatsApp session data. Preserve conversations, memory, jobs, automations, service/provider credentials, and config. Do not restart without a paired session.
- Add a daemon heartbeat and gateway connection record, using an atomic runtime-status file or a small migration-backed table, so status reports connecting, connected, disconnected/reason, last connected time, and paired account without secrets.

Tests:

- Use a fake Baileys socket at the pairing boundary to cover QR, phone code, open, timeout, logout, cancellation, staged commit, rollback, daemon stop/restart, and destructive clear.
- Run CLI PTY setup tests proving WhatsApp is first, owner is required and distinct, completed steps resume, and service validation retries in place.
- Add a manual smoke step that pairs a real test WhatsApp account using both supported methods on a disposable VPS.

## Phase 4: production provider authentication and model selection

Use pi-ai as the authentication and model-capability authority where specified.

- Add a file-backed pi-ai `CredentialStore` under `~/.poke`, with mode `0600`, atomic writes, serialized `modify`, and cross-process locking. Move provider secrets out of general config.
- Add a one-time safe migration for existing credentials:
  - Move valid Fireworks and Command Code keys to the credential store without printing them.
  - Treat the existing fabricated Codex access-token record as non-refreshable and require a fresh device-code login.
  - Preserve the old store until the new store is durably written and validated.
- Build one Poke-owned pi-ai `Models` collection around that store. Use it for login, auth health/refresh, current Codex models, and exact thinking-level metadata.
- For Codex, call pi-ai's current OAuth login flow and select its `device_code` path directly. Show the verification URL and user code, poll with a progress state, persist the returned refreshable credential, and never ask the user to paste an access token.
- For Fireworks, collect a masked API key through the same credential boundary, validate it, and fetch the live account model list. Combine live availability with authoritative provider/pi-ai metadata; an unknown live model remains selectable with provider-default reasoning.
- For Command Code, validate the key against `GET /provider/v1/models`. Keep the section 16.4 capability precedence inside `CommandCodeCatalog`: live metadata, current official package metadata, small known-model map, then default-only for unknown models.
- Preserve the prior credential when replacement login or validation fails. Re-authentication is explicit and never prints the existing value.
- Register Flue provider adapters whose request-time auth resolver calls the Poke pi-ai store, allowing serialized OAuth refresh during daemon operation. Command Code remains a direct Provider API adapter. Do not pass OAuth credentials through `OPENAI_API_KEY`.
- Normalize every catalog to `{ id, name, capabilities }`. Codex uses the authenticated pi-ai catalog rather than `src/providers/codex.ts` hardcoded data. Remove stale `o1`/`gpt-4o` fallback behavior.
- Rebuild `poke model` and `poke model worker` on the shared selector:
  1. Show the current independent selection.
  2. Choose an authenticated provider.
  3. Fetch all models currently available to the account.
  4. Show reasoning only if that exact model has explicit values.
  5. Validate the final provider/model/effort immediately before atomic save.
- Require valid main and worker selections before daemon start. Remove `openai-codex/gpt-4o`, worker-to-main, or any other silent runtime fallback.
- On auth expiry, refresh through pi-ai. On unrefreshable auth, removed models, or rejected capabilities, fail clearly in inference, status, doctor, and a sanitized direct WhatsApp operational message.

Tests:

- Fake pi-ai's `Models` and `AuthInteraction` public seams to prove Codex chooses device code, renders URL/code, persists refresh credentials, refreshes once under concurrency, and preserves old credentials on failed replacement.
- Contract-test normalized live catalogs for all three providers, exact reasoning lists, unknown/default-only models, disappearing models, and no fallback.
- Assert no command output, log, exception, or persisted non-secret config contains tokens or API keys.
- Add env-gated live authentication/catalog checks to the VPS smoke script without committing credentials.

## Phase 5: truthful lifecycle, status, doctor, and logs

- Make systemd the Ubuntu lifecycle path. Install/update a bounded-restart user-owned unit, use the same absolute Node executable as the CLI, and make start/stop/restart idempotent.
- Implement graceful daemon shutdown: stop accepting gateway events, persist in-flight state, close WhatsApp, stop the scheduler, and close Flue/database handles within a documented timeout. Administrative stop must not mark durable queued jobs as user-aborted.
- Make PID and heartbeat handling resilient to stale files and process-ID reuse. Report systemd and daemon state consistently.
- Rebuild `poke status` from read-only config/database/runtime status. Include every section 19.6 item: daemon/PID, real WhatsApp state, main and worker selections, agent activity, approximate context plus thresholds, workers, automations/next due, and last operational error.
- Rebuild `poke doctor` as truly read-only. Opening it must not create directories, migrate the DB, edit config, refresh destructively, or start a gateway. Check every section 19.7 item and return nonzero for required failures. Report pending migrations rather than applying them.
- Make diagnostic service calls cheap, bounded, and secret-safe. Validate both model selections against current catalogs and exact reasoning capability.
- Centralize structured logs and operational error mapping. Add correlation IDs for WhatsApp message, Flue submission, worker, automation, provider attempt, and send. Remove message/transcript previews and sanitize arbitrary error strings before logs or WhatsApp.
- Keep `poke logs` and `poke logs -f` useful when the daemon is down, with structured recent output, graceful missing-log behavior, and no private message bodies by default.

Tests:

- Snapshot status/doctor output for healthy, stale, partial setup, expired auth, removed model, broken service, pending migration, disconnected gateway, and stopped daemon states.
- Assert a byte-for-byte state-directory snapshot is unchanged by doctor.
- Exercise systemd unit install, daemon restart, SSH disconnect survival, graceful stop, and bounded failure restart in the VPS script.

## Phase 6: durable WhatsApp event and delivery semantics

Close crash windows at the gateway/Flue boundary before adding more features.

- Normalize owner-only direct messages exactly as section 5 specifies. Ignore groups, status/broadcast traffic, and non-owner direct messages without agent dispatch.
- Use the WhatsApp chat and message IDs to form a stable Flue `idempotencyKey`. Persist receipt/admission state transactionally so redelivery after a crash cannot create a second submission.
- Keep direct owner messages at the highest delivery priority. Preserve arrival order, steer active work at the next turn boundary, and create the next submission when steering is no longer possible. Do not batch or debounce.
- Make exact text `/stop` an out-of-band durable operation. Abort main work and running workers, cancel queued workers, suppress late success signals, and send one idempotent `Stopped.` acknowledgement. All near-matches remain normal input.
- Normalize text, captions, image, document, video, audio, and voice. Save original media under stable private paths. Prefix voice transcripts with `[voice]`.
- Send a direct operational WhatsApp error when media download or transcription fails rather than dispatching a misleading empty message. Keep the original file when available.
- Attach an image natively only when the selected model explicitly accepts images and provider size/type limits pass. Always retain the stable local path for tools.
- Redesign `send` around a durable outbox keyed by Flue submission, tool call, and content part. Persist intent before network send and terminal state after it. Reconcile ambiguous outcomes conservatively rather than blindly retrying non-idempotent sends.
- Implement text and PTT voice modes. Move TTS to current Deepgram Flux `POST /v2/speak`, use a supported Flux voice/audio format, store the generated artifact, and send it as a WhatsApp voice note.
- Add migrations for idempotency/admission, outbox/delivery state, gateway heartbeat, and last operational error. Migrations are append-only and preserve existing conversations and jobs.

Tests:

- Cover every section 23.1 through 23.3 scenario with a real file-backed database and fake external transports.
- Inject crashes after receipt, Flue admission, outbox intent, transport return, and delivery persistence; replay events and prove one logical dispatch/acknowledgement.
- Assert normal Flue final output never reaches WhatsApp unless `send` was called.

## Phase 7: current service integrations and retry policy

- Exa: validate the key with a bounded read call, keep `web_search` and `web_fetch` outputs bounded, preserve source metadata, and map provider errors without leaking query-private content.
- Supermemory: replace the obsolete `/v3` request shapes with the current official SDK or v4 API. Use one stable owner container/tag, correct search fields and response parsing, explicit limits, and no retry of ambiguous writes without an idempotency guarantee.
- Composio: use current `@composio/core` and one stable owner session. Expose only the POKE v1 search and execute capabilities to agents. Keep connection-management/admin tools out of the permanent surface. Do not replay an ambiguous non-idempotent action.
- Deepgram: use current prerecorded transcription and Flux TTS endpoints, validate media limits, and distinguish invalid auth, unsupported media, transient service failure, and empty transcription.
- Split retry handling by operation semantics. Provider inference gets the specified approximate 2s, 5s, 10s, and 20s schedule for retryable failures only, including `Retry-After`; invalid credentials/config fail immediately. Read-only/idempotent service calls may use bounded retry. Mutations need provider idempotency support or no automatic retry.
- Every exhausted provider inference sends the section 17 operational error directly through the durable sender with provider, model, and attempt count, while logs retain sanitized diagnostics and correlation IDs.

Tests:

- Add adapter contract tests from current official response fixtures plus env-gated live read-only checks.
- Prove transient and terminal classification, retry timing with a fake clock, `Retry-After`, no mutation replay, and secret-safe errors.

## Phase 8: Flue conformance, skills, workers, and automations

- Construct main and worker local sandboxes with `local({ env: { ...process.env } })` as required by `POKE.md`, while explicitly removing Poke/provider secrets that should stay behind host tools and auth resolvers.
- Reconcile permanent main and worker tool surfaces against sections 7 and 8. Workers cannot `send`, spawn jobs, or access the main transcript. The main agent keeps unrestricted host work and the product capabilities specified in the prompt.
- Replace the custom prompt-only skill activation path with current Flue dynamic skill/resource primitives. Re-scan the canonical skill directory before every render so add/edit/delete appears on the next turn. Mount full instructions only after activation and reject unknown conditional capabilities.
- Keep the automations skill discoverable. Clear mounted conditional tools only after successful compaction, not on a failed attempt.
- Preserve four-worker concurrency and a durable FIFO queue. Give each worker a fresh conversation, complete standalone instruction, independent validated model selection, stable artifact paths, and explicit start/finish/result metadata.
- Use stable worker completion idempotency keys and transactionally record completion admission. A completion wakes the owner conversation exactly once across crashes and restarts. Global `/stop` suppresses late success.
- Make scheduler claims and outcomes durable. One-time missed work runs once on restart; recurring schedules skip missed occurrences and compute only the next future time in `Asia/Karachi`.
- Dispatch automation signals to the owner conversation with `automation:<id>:<scheduledAt>` idempotency. Preserve owner-message priority and avoid duplicate execution around claim/dispatch crashes.

Tests:

- Implement every section 23.4 through 23.6 case against the actual file-backed runtime boundary where practical.
- Add restart/crash cases for worker queue claims, terminal result dispatch, one-time automation catch-up, and recurring next-run calculation.
- Modify the skill directory during an active conversation and prove add/edit/delete without restart or compaction.

## Phase 9: real two-tier compaction

- Replace incoming-character estimates with token usage from Flue observations/renders for the active owner conversation. Persist the latest approximate token count and last user activity for status/restart continuity.
- Configure active compaction around 272k tokens regardless of a larger model context window. Derive Flue reserve settings from the selected model's authoritative context window, with a small safety margin, instead of relying on its percentage/default threshold.
- Implement the 30-minute idle policy: below 100k does nothing; at or above 100k compacts; new activity resets the timer; a cold message after the threshold performs supported preflight compaction before inference.
- Preserve the generated summary plus about 20k recent raw tokens. Only replace durable conversation state after successful compaction.
- If current Flue cannot trigger durable root-agent idle compaction through a supported API, upgrade to the nearest compatible version or add the smallest adapter at that boundary. Do not use a scratch-harness API that bypasses the owner conversation.
- On compaction failure, keep the full existing conversation, retain conditional tool state, record a sanitized operational error, and retry only through an explicit bounded policy.

Tests:

- Implement every section 23.8 threshold, timer-reset, preflight, retained-context, and failure-preservation case with controlled token observations and time.
- Add a long-conversation restart test proving persisted thresholds and continued owner conversation identity.

## Phase 10: release acceptance and POKE.md coverage audit

Create a traceable acceptance matrix that links every normative statement in `POKE.md` sections 1 through 21 to code and evidence. Run it after all phases, not as a documentation-only exercise.

- Convert sections 23.1 through 23.8 into named integration suites. Keep external APIs behind deterministic contract fakes for CI and add a short env-gated live suite for catalogs/connectivity.
- Replace the current fake-key VPS smoke test with an executable Ubuntu checklist that covers fresh install, setup, real WhatsApp pairing, each provider login, independent main/worker selection, daemon/systemd restart, real text/media/voice, skill hot reload, four workers plus queue, automation catch-up, compaction trigger, status, doctor, and logs.
- Test upgrade from the current repository state with existing config, database, WhatsApp session, service keys, and jobs. Verify migrations preserve data and flag the obsolete Codex credential for re-login without damaging other credentials.
- Run clean-install gates, audit gates, unit/integration suites, TypeScript, build, daemon soak/restart, log redaction checks, and the manual VPS smoke script.
- Review the final command surface, tool surface, on-disk layout, prompts, status fields, and operational errors directly against `POKE.md`. Delete superseded readline, stale catalogs, legacy Composio, placeholder re-authentication, silent fallbacks, and unused compatibility code.
- Record any remaining failed or untestable requirement as a release blocker. Do not label Poke v1 complete while a section 23 scenario, section 24 capability, supported-install warning, known security finding, or spec mismatch remains.

## Required execution order and merge gates

Implement in the phase order above. Phases 1 through 4 establish the shared boundaries used everywhere else; merging later runtime work before those boundaries would duplicate credential, UI, and connection logic.

Each phase must leave the repository buildable and pass its narrow tests plus the existing suite. Before release, run the complete gate in one clean supported environment:

```text
npm ci
npm audit --omit=dev
npm run typecheck
npm test
npm run build
poke doctor
<VPS smoke script>
```

The final handoff includes the acceptance matrix, clean-install output, audit result, automated test result, and dated VPS smoke-test result. Those artifacts, rather than an implementation claim, are the evidence that Poke matches `POKE.md`.

## Official references to verify during implementation

Use installed package types first, then current official documentation for consequential external contracts:

- Flue Agent API, tools, skills, sandboxes, and models linked in `POKE.md` section 25.
- pi-ai installed `Models`, `CredentialStore`, OAuth `AuthInteraction`, and provider types.
- Baileys pairing and `requestPairingCode`: <https://github.com/WhiskeySockets/Baileys/blob/master/README.md>
- Node SQLite stability: <https://nodejs.org/api/sqlite.html>
- npm dependency lifecycle-script policy: <https://docs.npmjs.com/cli/using-npm/config>
- Composio current SDK migration: <https://docs.composio.dev/docs/migration-guide/new-sdk>
- Deepgram Flux API: <https://developers.deepgram.com/reference/speak/v-2/audio/generate>
- Supermemory current search API: <https://supermemory.ai/docs/api-reference/recall-search/search-memory-entries>

