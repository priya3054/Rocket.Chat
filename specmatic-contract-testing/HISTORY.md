# Specmatic contract testing — full history

Detailed, evidence-level log behind [`README.md`](./README.md)'s summary.
Every finding below was verified live (a real request/response, a real log
line, or a real source file citation) — nothing asserted on assumption.

## Ground rules

- **The contract never changes.** `contracts/` is a git submodule pinned to
  a plain, untouched mirror of `RocketChat/Rocket.Chat-Open-API`. A mismatch
  gets fixed in the app — never the spec.
- Exception: an objective, mechanical spec defect that blocks
  parsing/testing (e.g. a missing `/api` path prefix). Fixed via an
  in-memory OpenAPI Overlay (`--overlay-file`), never a spec edit.
- Docker image: `specmatic/specmatic:2.50.0` (open source), pinned.

## Findings by spec file

Categories used throughout: **App fix** (Rocket.Chat's behavior didn't
match the contract, fixed in the app), **Spec blocker** (objective OpenAPI
defect, logged, never patched), **Accepted drift** (a real, deliberate
mismatch left as-is — usually the app doing more/richer than the docs say).

### `authentication.yaml` (11 ops)
- **App fix**: an unrecognized login-body key (e.g. `resume` alongside
  password fields) threw an unhandled `Match.Error` → raw `500` instead of
  a clean `4xx`. Root cause: `ApiClass.ts`'s `loginCompatibility()` passes
  unrecognized-shape bodies through unnormalized; `Match.Error` isn't a
  `Meteor.Error` subclass so it fell through the generic 500 branch. Fixed
  by converting it to its own sanitized `Meteor.Error(400, ...)` before the
  existing error-type check.
- **App fix**: `POST /api/v1/logout` returned `200` with an **empty body**
  on every real call. The handler built the right message but returned it
  bare instead of `self.success(response)` — the HTTP router
  (`packages/http-router/src/Router.ts:256-261`) needs a `{statusCode,
  body}` envelope; a bare object has neither key. Fixed: one-line change to
  `return self.success(response);`.
- **Spec blocker**: `/login - with Facebook/Twitter/Google` are declared as
  3 separate paths, but `ApiClass.ts:1055` routes every login variant
  through one real handler — these paths 404 by construction, never real
  endpoints. Excluded via `--filter`, not edited.
- **Spec blocker, resolved**: `twoFactorChallenges.sendEmailCode`/
  `verifyChallenge` have no matching route anywhere. Confirmed this is a
  pure spec-authoring mismatch: real 2FA re-submits the *original* request
  with the code attached rather than using a separate verify endpoint.
  Nothing to build.
- **Accepted drift**: `login`/`GET /me` return several real, genuinely-used
  fields the spec doesn't declare (`success`, `avatarOrigin`,
  `statusDefault`, `_updatedAt`, `services`, `banners`, `isOAuthUser`,
  `settings.profile`, `settings.calendar`).
- **Accepted drift**: `users.2fa.sendEmailCode` returns `200` for both real
  and non-existent accounts (spec says `400` for non-existent) —
  intentional, avoids a user-enumeration vulnerability.
- Excluded via `--filter` (test isolation, not a defect): `logout` would
  invalidate the one shared admin token every other test in the suite
  depends on.
- Deferred: `users.2fa.enableEmail`/`disableEmail` (need real 2FA/SMTP
  wiring not built here).

### `content-management.yaml` (16 ops)
- Clean pass: `emoji-custom.all/list`, `custom-sounds.list`,
  `custom-user-status.list`, `custom-sounds.getOne` (404 path),
  `custom-user-status.create/update/delete` (real lifecycle).
- Deferred: 8 multipart file-upload operations (`emoji-custom.*`,
  `custom-sounds.create/update/delete`, `assets.setAsset/unsetAsset`) —
  need real file content, bigger lift than JSON, out of scope.

### `notifications.yaml` (8 ops)
- Clean pass: `banners`, `banners/{id}`, `banners.dismiss` (404 path),
  `push.info`, `push.token` (DELETE).
- **Accepted drift**: `push.token`'s real field is `result._updatedAt`;
  spec says `result.updatedAt` — looks like a one-off spec typo (every
  other endpoint correctly uses `_updatedAt`).
- Deferred: `push.get` needs a real message ID (depends on
  `messaging.yaml`).

### `messaging.yaml` (44 ops, ~35 exercised)
- Required `--lenient` — the spec's *own* inline examples (not ours) have
  defects (inconsistent types, missing required headers) that otherwise
  abort loading the whole file to 1 synthetic test.
- **Accepted drift, systemic**: undocumented real fields on
  message/room/error objects (`_id`, `alias`, `attachments`, `pinned`,
  `reactions`, `starred`, `tcount`, `urls`, etc. — 336 occurrences, ~24
  distinct fields). `reactions` modeled as one hardcoded emoji key instead
  of a free-form map. `md[].value[].value` is genuinely polymorphic
  (string, object, or array) but the spec fixes it as one type.
  `dm.counters.unreadsFrom` is really `null`; spec says plain `string`.
- Real, legitimate non-2xx paths (not bugs): `chat.getMessageReadReceipts`
  (EE-gated), `dm.messages.others` (disabled by default), `im.blockUser`
  (no second user to block), `autotranslate.*` (feature disabled).
- **Spec blocker**: `autotranslate.saveSettings` returns a real `400` the
  spec doesn't declare at all (only `200`/`401`).

### `rooms.yaml` (154 ops, spot-checked + later fully exampled, 148 paths)
- Exhaustive on `channels.*`; `groups.*`/`teams.*` spot-checked and
  confirmed byte-identical behavior (same underlying room-service code).
- **Spec blocker**: `teams.update.data.name/type` not marked required but
  the app requires them. Same pattern: `roles.addUserToRole`'s `required`
  list names `roleName`, a property that doesn't even exist (`roleId` is
  real) — spec's own internal contradiction.
- Real, undocumented validation quirks found (not bugs, just
  under-documented): `teams.leave.rooms` must be non-empty;
  `channels.leave` only recognizes `"c"`-type rooms; `rooms.saveNotification`
  uses flat keys not nested ones; `uploads.delete` only accepts `fileId`;
  `rooms.muteUser` requires current room membership; `useInviteToken`
  needs the invited user's own session, not the admin's;
  `channels.addOwner/setReadOnly/open-close` all have real state-dependent
  errors the plain schema doesn't capture; `rooms.isMember`'s param is
  `userId` not `username`.
- **Spec blocker (load-abort bug, found 3x here)**: `listInvites`,
  `channels.kick`, `channels.roles` declare zero/incomplete auth
  parameters — an example with those headers anyway aborts loading for the
  *entire spec file* down to 1 test. Fixed by dropping the headers to
  match the spec exactly (real, correctly-unauthenticated `401`).
- **Accepted drift, dominant category (~3,100 of ~3,700 violations)**: the
  shared `channel`/`group`/`room`/`team` response schemas are broadly
  incomplete vs. real data (`announcement`, `description`, `prid`, `ts`,
  `teamId`, nested `lastMessage.md[]`, etc.).
- **App fix**: `GET /app/{id}/logs` declared without the `/api/apps`
  prefix — real path is `/api/apps/{id}/logs`, no EE license needed.
  Fixed via overlay.
- Enterprise-gated: `abac.*`, `audit/rooms.members`.
- **App fix (this session)**: `channels.anonymousread`'s committed example
  assumed "anonymous" meant "no headers" — the route needs
  `authOrAnonRequired`, so it 401'd before reaching the check it meant to
  test. Fixed the example and its expected error text. Deeper, unfixable
  finding: the spec declares **no** auth parameters at all for this
  operation, so Specmatic silently drops any auth headers an example
  supplies (confirmed by inspecting the literal request sent) — no way to
  test this operation's documented `400` path through Specmatic's example
  mechanism at all.
- Deferred: `rooms.export/cleanHistory` (destructive), `rooms.media`
  (file upload), 3 remaining `abac.*` ops.

### `omnichannel.yaml` (165 ops, spot-checked + later 141 paths exampled)
- Livechat is enabled on this instance, but real visitor-room/message
  creation is blocked: agent "online" presence needs a live WebSocket
  session a REST-only admin can't establish. Covered everything reachable
  without an online agent (~45 ops); documented the rest as a real,
  verified environment gap, not faked.
- Real validation quirks found: only one department ever allowed on CE;
  department removal disabled by default (fixed the script to
  fetch-or-update instead of delete-recreate); `agents.saveInfo` needs
  `agentId` not `_id`; `department` PUT needs `email` even for unrelated
  updates; `department.autocomplete`'s `selector` must be JSON-stringified;
  `custom-fields.save` needs a nested `customFieldData` wrapper;
  `business-hours.save` needs flat `timezoneName`/`daysOpen`, and saving is
  not EE-gated while *listing* business hours is.
- **Spec blocker (load-abort, same bug class)**: `livechat/visitor/{token}`
  and `livechat/page.visited` don't declare auth params (they're genuinely
  public, visitor-facing endpoints) — fixed by dropping headers to match.
- Enterprise-gated: `tags`, `business-hours` listing, `priorities`, `sla`,
  `units`, all `analytics/departments/*`, `canned-responses`,
  `livechat/monitors`, `contacts.block/unblock`.
- **Accepted drift**: `livechat/config` and `visitor/{token}` return real,
  rich data (`host`, `ip`, `triggers`, etc.) the schema doesn't declare.
- Deferred: everything downstream of the no-online-agent constraint
  (`livechat/room*`, `message*`, `transcript*`, `upload`), SMS/external
  webhook-dependent ops.

### `user-management.yaml` (56 ops, ~30 then all reachable exampled)
- Clean pass: `users.create/info/list/setStatus/getPresence`,
  `permissions.listAll`, `roles.list`, `roles.addUserToRole`, and more.
- **Accepted drift, matches spec exactly**: `users.generatePersonalAccessToken`/
  `resetTOTP`/`resetE2EKey` correctly return `"TOTP Required"` — verified
  this is the spec's own documented `400` example, verbatim.
- Enterprise-gated: `roles.create`/`update`.
- **Spec blocker (load-abort, same bug class)**: `users.getStatus`/
  `sendConfirmationEmail` declare **zero** parameters, not even auth
  headers — including them anyway aborts the whole file's load. Fixed by
  omitting them, which correctly produces a real `401`.

### `settings.yaml` (real app bug + 2 dead-feature findings)
- **Real app bug, unresolved, flagged not blind-fixed**: `GET
  /api/v1/instances.get` leaks a raw internal error, `"Service
  '$node.list' is not available."` — undocumented `400`, a Moleculer
  broker message, not Rocket.Chat's own. Traced to
  `ee/server/local-services/instance/service.ts:214`; confirmed via
  container logs that the service degrades ~3.5 hours after boot on a
  single-node deployment (tight `heartbeatInterval: 10s`/`heartbeatTimeout:
  60s` is the likely cause, not fully proven). Two valid fixes identified
  (relax heartbeat timing, or degrade gracefully to an empty list instead
  of leaking) — left for a team decision.
- **Confirmed dead feature**: `federation/listServersByUser/addServerByUser/
  removeServerByUser` — real frontend code calls them
  (`MatrixFederationSearch/`), but no backend route or service has ever
  existed since the UI landed in a single 2023 commit. Recommended
  removing the dead UI (every action in it 404s today) rather than
  building a backend against a superseded federation architecture.
- Minor: `dns.resolve.txt/srv` also 404, zero references anywhere in the
  codebase — likely spec-only, never built.
- **Spec blocker**: `integrations.create`'s `requestBody.required`
  unconditionally lists `event`/`urls`, contradicting its own description
  ("Required for outgoing integrations" only).
- **App fix**: `GET /media-calls.state` declared without `/api/v1` prefix
  — real path `/api/v1/media-calls.state`. Fixed via overlay (this
  project's first overlay fix, later followed by 4 more of the same
  pattern).
- Enterprise-gated: `sessions/*`.

### `integrations.yaml` (13 ops, all exampled)
- **Real finding**: `integrations.update` requires `token` in the request
  body itself, even when the stored integration already has one
  (`updateOutgoingIntegration.ts:28-34`).
- **Accepted drift**: `integrations.get`/`oauth-apps.get` return
  undeclared fields (`token`, `skipTranspile`, `_updatedBy`).
- **App fix**: `apps/count` and `apps/buildExternalAppRequest` declared
  without `/api` prefix. `buildExternalAppRequest` also needed a second
  fix: spec declares zero query params, but the real handler 400s without
  `appId`. Both fixed via overlay.
- **Type mismatch**: `oauth-apps.delete` returns a bare JSON boolean
  `true`; spec declares an object (`{success: boolean}`).
- **App fix**: `licenses.maxActiveUsers` declared without `/api/v1`
  prefix. Fixed via overlay — but hits a second, unfixable wall: on this
  unlicensed instance the real value is `null`, while spec declares
  `integer`; Specmatic won't accept `null` for a committed `integer`
  example, so no honest passing example is possible here.

### `marketplace-apps.yaml`, `statistics.yaml`, `miscellaneous.yaml`
- `statistics.yaml`: clean pass on the 2 reachable ops; all 9
  `engagement-dashboard.*` ops uniformly EE-gated.
- `miscellaneous.yaml`: clean pass on most read ops.
  **Real finding**: `email-inbox.send-test` declared `GET` in the spec but
  the app registers it as `POST` (`email-inbox.ts:222`).
  **Real finding**: `calendar-events.info`'s query param is `id`, not
  `eventId` like its siblings.

### Overlay-mechanism bugs (found and fixed this session)
- **The overlay file itself had a bug that silently discarded fixes.**
  Five path-prefix fixes had each been added as their own separate
  `- target: "$.paths" / update:` action over several sessions.
  Specmatic's overlay engine replaces the prior `$.paths` update wholesale
  on each subsequent action targeting the same JSONPath rather than
  deep-merging — so only the *last* action's addition ever actually took
  effect. `media-calls.state`'s fix had been silently broken since a
  second fix was added after it, and nothing caught it until this pass.
  **Fixed**: merged all five into one action with one `update:` map (five
  sibling keys); the five `remove` actions stay separate (different
  JSONPaths, don't conflict).
- **A second bug in the same file**: every parameter/response had been
  `$ref`'d against `#/components/parameters/...` and
  `#/components/responses/...`. Since this one overlay applies across all
  12 specs in a single invocation, a `$ref` only resolves inside whichever
  spec originally declared that component name — grafted into a different
  spec, it silently fails and Specmatic aborts the *entire suite* with a
  hard load error. **Fixed** by inlining every parameter/response
  definition instead of referencing shared components.
- Verified after both fixes: all five path corrections register correctly
  in the full 12-spec run (`apps/count`: 24/24 passing, `apps/{id}/logs`
  404 case: 24/24 passing, `buildExternalAppRequest`: 12/24 passing).
  Successes rose from 197 → 238 in the same run.

## Coverage measurements over time

| Date | Coverage | Tests | Successes | Failures | Errors |
|------|----------|-------|-----------|----------|--------|
| First full run | 4% | 1238 | 47 | 635 | 556* |
| After `media-calls.state` fix | 5% | 1271 | 53 | 1218 | 0 |
| After real examples added to all 12 specs | 17% | 1462 | 197 | 1265 | 0 |
| After this session's fixes | 17% | 1555 | 238 | 1317 | 0 |

\* The 556 errors were `Request timeout` on
`livechat/offline.message` under sustained rapid-fire load — reproduced in
isolation with zero hangs; raising `--timeout-in-ms` to 15000 eliminated
all 556. Not a real hang/crash, just Specmatic's default 6s client timeout
under heavy synthetic load.

**Why 4%→5%→17% didn't need editing the spec, and why it's stuck near
17% now:** getting every operation a real example was the easy, mechanical
part — it turned out not to be the limiting factor. What caps coverage now
is five structural, root-caused reasons (see README's table), confirmed by
tracing every failure class to one of them, not a backlog of undiscovered
bugs.

**Why no `--config`/`governance.successCriteria`:** supplying `--config`
alongside `--examples` silently disables external example loading
entirely in this pinned image (its own config schema doesn't even have an
`examples` key). So the gate is enforced by parsing stdout instead.

## Resiliency (fuzz) testing

Same 12 specs, `schemaResiliencyTests: all` instead of `none` — mutated/
fuzzed input, checking Rocket.Chat degrades gracefully instead of
crashing. Kept fully separate from the correctness run (blending both
produces an unreadable wall of failures).

**Full 12-spec run: 30,570 tests, 4,083 successes, 26,487 failures, 0
errors/crashes.** Rocket.Chat never crashes, hangs, or 500s under fuzzed
input — every failure is a spec-shape mismatch. Response-code coverage
~56%. The other 44% breaks down as:
- 23 of 582 operations declare zero error/default response at all — any
  negative-path fuzz test against them is structurally unverifiable.
- R2003 (67,666 occurrences) collapses into: the generic `{success,
  error}` shape not declared wherever an error schema exists (~25,740);
  the already-known rooms.yaml shared-shape gap; **new**: `settings.yaml`'s
  per-setting items declared as only `{_id, value}` when real objects are
  much richer; **new**: `integrations.list.channel` declared as an empty
  object stub; **new**: several `integrations.list` fields declared
  non-nullable but genuinely `null`.
- 234 cases are real rate-limiting (`429`) correctly kicking in under fuzz
  volume on public endpoints — not a bug.
- 694 cases (94% on 2 public app-webhook endpoints) are real `404`s
  because no marketplace app is installed in this environment — needs a
  real `.zip` test app to close, out of scope.
- A meaningful share are Specmatic's own generated "body omitted/mandatory
  keys only" scenarios against operations with real required fields — the
  server correctly rejecting these is not a bug.

**One real bug found and fixed via this run**: `GET /app/{id}/logs`
(same missing-`/api/apps`-prefix pattern as `media-calls.state`).

**Dictionary added** (`specmatic/dictionaries/rooms_dictionary.yaml`) so
generated/fuzzed values are domain-realistic instead of random noise.
Only applies to `rooms.yaml` (the only spec file with named schema
components, `Attachment`/`Subscription`, that a dictionary can key
against) — auto-discovered by Specmatic via `<spec-basename>_dictionary.
yaml` naming, no CLI flag needed. Required mounting each spec file
individually rather than as one directory (Docker refuses a nested bind
mount inside a read-only directory mount).

**Reframing (2026-07-20):** stopped chasing 100% response-code coverage —
most of the gap is accepted drift or structurally-unwinnable scenarios.
`specmatic_resiliency.yaml` now loads real examples too (via
`components.services.<name>.data.examples.directories` config, since
`--config`+`--examples` can't combine on the CLI) — malformed input is now
tested against a real logged-in session, the realistic attack surface.

## CI (GitHub Actions, no PR — pushed directly to `origin`, the user's own fork)

Four workflows, each scoped via `paths:` to `specmatic-contract-testing/**`:

- **`specmatic-consumer-mock.yml`** — hard gate. Mock server smoke-test,
  no live app needed. Should always pass.
- **`specmatic-contract-test.yml`** — live app, all 12 specs. Coverage %
  is informational only, not gated (see README). Real gate: fails if
  Specmatic reports `Errors > 0` or `Successes == 0`.
- **`specmatic-resiliency-test.yml`** — same live setup, fuzzed input.
  Fully report-only.
- **`specmatic-examples-lint.yml`** — validates the spec submodule's own
  inline examples, no live app. Report-only (pre-existing upstream issues
  aren't this branch's fault to block on).

All four upload HTML reports as build artifacts and tear down containers
unconditionally.
