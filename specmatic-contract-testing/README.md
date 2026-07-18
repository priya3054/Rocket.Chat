# Specmatic contract testing

Contract testing for the Rocket.Chat REST API using
[Specmatic](https://specmatic.io) against the project's official OpenAPI
spec. Self-contained: doesn't touch `apps/`, `packages/`, or any other part
of the build.

## Ground rules

- **The contract never changes.** `contracts/` is a git submodule pinned to
  `priya3054/Rocket.Chat-Open-API`'s `main` branch, which is a plain,
  untouched mirror of upstream `RocketChat/Rocket.Chat-Open-API` (verified
  same commit as upstream when pinned: `ad77de5`). No fork with hand-applied
  fixes is used anywhere in this setup. When Specmatic finds a mismatch
  between the contract and the live app, the app gets fixed — not the spec.
- The one exception: an objective, mechanical defect that blocks
  parsing/testing entirely (invalid OpenAPI syntax, a value that crashes
  Specmatic itself). Even then the spec is never edited here — the affected
  operation is excluded via Specmatic's own filter/config, logged below, and
  left for a decision on whether to raise it against the spec repo
  separately, on its own timeline.
- Docker image: `specmatic/specmatic:2.50.0` (open source), not any
  Enterprise/commercial image.

## Layout

```
contracts/          Git submodule -- priya3054/Rocket.Chat-Open-API @ main,
                     pinned to a commit SHA. Read-only. All 12 spec files.
rocketchat-docker/   Docker Compose file for RocketChat + MongoDB.
specmatic/           Docker Compose overlay(s) running specmatic/specmatic,
                     configs, examples, and reports.
```

## Quickstart

Run from `rocketchat-docker/` so relative bind-mount paths resolve correctly
when merging multiple `-f` files.

### Bring up RocketChat + MongoDB

```sh
DEPRECATED_COMPOSE_ACK=1 docker compose up -d
```

Admin account is auto-provisioned (`admin` / `SpecmaticAdmin123!` by default,
override with `RC_ADMIN_PASS`) via
[`initialData.ts`](https://github.com/RocketChat/Rocket.Chat/blob/develop/apps/meteor/server/startup/initialData.ts)
on first boot of a fresh MongoDB container — if you're reusing an existing
container from a previous run, the admin user (and its password) already
exists and won't be reset by this env var.

### Consumer mock (stub server)

No RocketChat instance required — generated straight from the pinned specs
in `contracts/`.

```sh
DEPRECATED_COMPOSE_ACK=1 docker compose \
  -f compose.yml -f ../specmatic/compose.test.yml \
  --profile mock up specmatic-mock
```

Serves a schema-accurate fake RocketChat API on `http://localhost:9000`.

### Provider contract test (one spec file at a time)

Real RocketChat instance required. Currently covers `authentication.yaml`;
more spec files get added as each prior one's findings are triaged.

```sh
# 1. Bring up RocketChat + MongoDB (see above), wait for it to answer on :3000

# 2. Capture a live admin auth token into an external Specmatic example
#    (gitignored -- RocketChat issues a fresh token per container boot)
../specmatic/scripts/regenerate-auth-examples.sh

# 3. Run the contract test
DEPRECATED_COMPOSE_ACK=1 docker compose \
  -f compose.yml -f ../specmatic/compose.test.yml \
  --profile test up specmatic-contract-test
```

JUnit report lands in `specmatic/reports/contract/TEST-junit-jupiter.xml`.

**Important, verified empirically against `specmatic/specmatic:2.50.0`:**
supplying `--config` alongside `--examples` silently disables external
example loading entirely — the config schema in this version doesn't even
have an `examples` key (its own validation error lists `governance`,
`license`, `settings` as the only top-level `specmatic:` properties), yet
adding `--config` still suppresses the CLI `--examples` flag. Since
`schemaResiliencyTests` is off by default with no config anyway, this
contract run omits `--config` entirely for now; it comes back once
governance/coverage-gate config is wired (Step 4), at which point real
example loading needs re-verifying against that combination too.

## Issues found and fixed

Updated as each spec file is worked through against the live app (Step 3 of
the restart plan). Categories:
- **App fix** — Rocket.Chat's behavior didn't match the contract; fixed in
  the app, contract untouched.
- **Spec blocker** — an objective OpenAPI defect prevented testing an
  operation at all; excluded via config, not patched, logged for a separate
  decision on raising it upstream.
- **Accepted drift** — a documented, deliberate mismatch left as-is (e.g.
  additive fields), not treated as a defect on either side.

### 2026-07-18 — Consumer mock smoke test (all 12 specs)

All 12 spec files (`authentication`, `content-management`, `integrations`,
`marketplace-apps`, `messaging`, `miscellaneous`, `notifications`,
`omnichannel`, `rooms`, `settings`, `statistics`, `user-management`) loaded
and parsed cleanly in Specmatic's `mock` command — no crashes, no fatal
parse errors. Confirmed by serving `GET /api/v1/me` (correctly rejected with
`400`/`R2001` for a missing required header, proving contract-aware
validation is active) and `POST /api/v1/login` (returned a schema-valid,
fully-populated fake response). No spec-blocker or app-fix entries yet —
those require the provider contract-test pass (Step 3) against the live
app, one spec file at a time, still to come.

No issues to report yet from this step.

### 2026-07-18 — Provider contract test: `authentication.yaml`

11 operations. Real admin auth token supplied via
`regenerate-auth-examples.sh` + external Specmatic examples (`login.json`,
`get-me.json`) — not OpenAPI `securitySchemes` (the canonical spec declares
`X-Auth-Token`/`X-User-Id` as plain header parameters; the old branch's
"fix" of converting these to `securitySchemes` was itself an undocumented
spec-structure change, not repeated here).

**Accepted drift** — `POST /api/v1/login` and `GET /api/v1/me` both return
several real fields the spec doesn't document: `success`, `avatarOrigin`,
`statusDefault`, `_updatedAt`, `services`, `banners`, `isOAuthUser`,
`settings.profile`, `settings.calendar`. Confirmed these are genuine,
actively-used fields (e.g. `statusDefault` referenced across
`initialData.ts`, `slashcommands/status`, `services/calendar`, `api/v1/users.ts`
— not a leak) — same conclusion the old branch independently reached for
`GET /api/v1/me` alone; here it's confirmed for `POST /api/v1/login` too,
since both endpoints return the same user-profile shape. Left as-is: these
are additive, non-breaking fields, and removing real functionality just to
match a lagging spec would be a worse outcome than the mismatch itself.

**Accepted drift** — `POST /api/v1/users.2fa.sendEmailCode`'s spec example
`Example 1` documents `{"emailOrUsername": "test@email.com"}` (a
non-existent account) returning `400`; the live app returns `200`
regardless of whether the account exists. This is almost certainly
intentional: returning a different status for real vs. non-existent
accounts is a user-enumeration vulnerability, so the app's current
behavior (always `200`) is the more correct one. Not "fixed" back to
matching the spec's `400` — that would mean reintroducing the enumeration
issue.

**Spec blocker (excluded via `--filter`, not edited)** — `/api/v1/login - with
Facebook`, `- with Twitter`, `- with Google` are documented as three separate
path items, but `ApiClass.ts:1055` registers exactly one `login` route for
every login variant (password, OAuth, resume token, 2FA code all dispatch
through the same handler based on request body shape). These three paths
were never real, independently-routable endpoints — they 404 by
construction. This is a spec modeling choice (using path-name suffixes to
document body-shape variants instead of `oneOf` on the one real path), not
an app defect.

**Spec blocker (excluded via `--filter`, not edited)** — `POST
/api/v1/twoFactorChallenges.sendEmailCode` and
`.../twoFactorChallenges.verifyChallenge` are fully documented in the spec
but have **no corresponding route anywhere in `apps/meteor/server`** —
confirmed by exhaustive search, not just a naming mismatch. The real,
working equivalents are `users.2fa.sendEmailCode`/`enableEmail`/`disableEmail`
(all present in `apps/meteor/server/api/v1/users.ts`). This reads as a
genuinely undocumented gap between spec and reality: either a planned
feature that was never built, or a doc duplication under a second naming
scheme. **Flagged for a decision, not yet resolved** — implementing two new
REST endpoints is a real feature-scope question, not a mechanical fix, and
needs a call on whether that's in scope here.

**Excluded via `--filter` (test-isolation, not a defect)** — `POST
/api/v1/logout` invalidates the one shared admin token every other scenario
in this run depends on; calling it for real would 401 every subsequent
request. Same reasoning the old branch independently reached.

**Not yet resolved (scoped follow-up, not misclassified as fixed)** —
`users.2fa.enableEmail`, `users.2fa.disableEmail` still fail with `401`:
real auth headers aren't wired for these two yet (would need extending
`regenerate-auth-examples.sh`), and `disableEmail` additionally needs a
real `X-2fa-Code`, which isn't obtainable without SMTP configured in this
test stack to actually receive the email code. Left failing and documented
rather than filtered out, since it's a genuinely testable gap, just not
yet instrumented.

**Result:** 11 tests run (after excluding the 6 not-really-testable
operations above), 1 pass, 10 fail — all 10 accounted for by the three
categories above (2 accepted-drift patterns across 5 scenarios, 2 not-yet-
wired 2FA operations across 5 scenarios). Zero unexplained failures.

### 2026-07-18 — Provider contract test: `content-management.yaml`

16 operations (custom emoji, custom sounds, custom user status, assets).
Real auth extended from `authentication.yaml`'s pattern — same shared
admin token, one external example file per operation, written by the same
`regenerate-auth-examples.sh` (now covers both spec files).

**Clean pass, no drift** — 8 operations verified with real requests against
the live app, all matching the contract exactly:
- `emoji-custom.all`, `emoji-custom.list`, `custom-sounds.list`,
  `custom-user-status.list` (real headers, no body needed).
- `custom-sounds.getOne` with a nonexistent `_id` — exercises the
  documented `404`/"Custom Sound not found" path (no custom sound exists
  on a fresh instance, so this is the only real path testable here without
  first uploading a file — see below).
- `custom-user-status.create` → `update` → `delete`, a real, sequential
  lifecycle: the script seeds one real record via a live call (unique name
  to survive repeated script runs without a "name already in use" clash),
  then `update`/`delete` act on that same real `_id`. All three plain-JSON
  operations (no file upload), all passed.

**Not yet resolved (scoped follow-up, deferred — same treatment as
`authentication.yaml`'s 2FA gap)** — the remaining 8 write operations all
require `multipart/form-data` file uploads and aren't wired yet:
`emoji-custom.create`/`update`/`delete`, `custom-sounds.create`/`update`/
`delete`, `assets.setAsset`/`unsetAsset`. Building real external examples
for these means supplying actual file content (an image for emoji/assets,
an audio file for sounds) — a meaningfully bigger lift than a JSON body,
scoped as separate follow-up work rather than rushed. Left failing and
documented, not filtered out.

**Result:** 36 tests run, 8 pass with real requests (5 read + 3-operation
lifecycle), 28 fail — all 28 are either the 8 deferred multipart operations
or the same operations' own spec-declared dummy inline examples (which
carry no real credentials by design, so they 401 regardless of our real
example passing alongside them — same pattern seen in
`authentication.yaml`, not a new defect). Zero unexplained failures.

### 2026-07-18 — Provider contract test: `notifications.yaml`

8 operations (banners, push). All plain JSON/query params — no file
uploads, unlike content-management.yaml's write operations.

**Clean pass, no drift** — 5 operations verified with real requests:
`GET /api/v1/banners`, `GET /api/v1/banners/{id}` (both with real headers +
`platform=web` query), `POST /api/v1/banners.dismiss` (with a nonexistent
`bannerId`, exercising the real, documented "Banner not found" `400` path —
no banner exists on a fresh instance to dismiss a real one), `GET
/api/v1/push.info`, `DELETE /api/v1/push.token`.

**Accepted drift** — `POST /api/v1/push.token`'s real response field is
`result._updatedAt`; the spec declares `result.updatedAt` (no leading
underscore). Confirmed real and reproducible (not a typo on our side):
every other endpoint across every spec file tested so far uses `_updatedAt`
(the codebase's actual Mongo/Meteor convention — `emoji-custom.all`,
`custom-sounds.list`, `custom-user-status.list` all declare and return
`_updatedAt` correctly). This looks like a one-off spec typo (a missing
underscore) rather than an app inconsistency — renaming the app's field to
match would break that endpoint's consistency with every other endpoint's
naming convention, which would be a worse outcome. Left as-is.

**Not yet resolved (scoped follow-up — cross-spec dependency, not a
same-file gap like the others)** — `GET /api/v1/push.get` needs a real
message `_id` to test meaningfully; that requires a room and a message to
exist, which depends on `messaging.yaml` (not yet reached in this pass).
Deferred until messaging.yaml's real fixtures exist, rather than testing
against a fabricated ID that would only exercise the "not found" path
(already well-covered by other operations' not-found cases in this file).

**Result:** 18 tests run, 5 pass with real requests, 13 fail — 1 is the
genuine `_updatedAt` accepted-drift finding above, the rest are `push.get`
(deferred) plus the same "spec's own dummy inline example lacks real
credentials" noise pattern already established. Zero unexplained failures.

### 2026-07-19 — Provider contract test: `messaging.yaml`

44 operations (chat.*, dm./im.*, autotranslate.*) — the largest file so
far, more than the previous three combined. Real fixtures seeded by
`regenerate-auth-examples.sh`: a message posted to `#general`, a threaded
reply to it, and a DM room (self-DM, "notes to self" pattern). ~35 of 44
operations got a real external example exercising them against the live
app; the rest are genuinely deferred (see below).

**Required `--lenient`, and this directly contradicts a claim from the old
branch.** Without it, the spec's *own* inline examples (not ours) — e.g.
`dm.list`'s own example has an `md[]` value typed inconsistently, and
`dm.setTopic`'s own example omits its required auth headers — abort
loading for the entire file to one synthetic failure (`Tests run: 1`,
verified directly). With `--lenient`, `126` real tests run instead. The
old branch's README claimed `--lenient` "was found to drop the whole suite
to 1 test if even a single bad example aborted the run" — empirically,
for this spec file, the opposite is true: `--lenient` is what *fixes* that
exact collapse. Worth remembering: a claim from the old work is a claim
about the old work's specific situation, not a fact about Specmatic in
general — verify fresh each time rather than inheriting a prior
conclusion.

**Mechanical lesson (fixed on our side, not a finding about the app):**
initial external examples reused one generic "message object" shape
across every operation. Several were silently dropped at load time with
no error, even under `--lenient`, because each operation in this spec
hand-duplicates its own narrower "message" schema — `chat.getMessage`
declares `u.name`, `chat.postMessage`/`chat.sendMessage` don't;
`chat.getMessage` includes `reactions`/`mentions`/`channels`/`starred`/`t`,
others don't; none of them declare `attachments`/`parseUrls`/`md`, even
though the live app always returns them. Fixed by trimming our own
examples to just the fields common to every schema checked (`_id`, `rid`,
`msg`, `ts`, `u._id`, `u.username`) — safe everywhere, since none of these
per-operation schemas mark any message sub-field as required.

**Accepted drift, systemic (not 105 separate bugs — every failure below
collapses into one of these categories):**
- **Undocumented real fields**, the largest category by far. The live app
  consistently returns fields no operation's schema declares, inconsistently
  across operations: `_id`, `alias`, `attachments`, `details`, `editedAt`,
  `editedBy`, `groupable`, `parent`, `parseUrls`, `pinned`, `pinnedAt`,
  `pinnedBy`, `reactions`, `replies`, `starred`, `t`, `tcount`, `tlm`,
  `tmid`, `urls`, `errorType`, `_hidden` — confirmed by direct count across
  the full run (336 occurrences, ~24 distinct field names, only 2 distinct
  *type*-mismatch locations — see below). Same root cause identified once
  already for `authentication.yaml`/`notifications.yaml`, at much larger
  scale here since almost every chat/DM operation returns a message, room,
  or error object.
- **`reactions` modeled as a literal key, not a map.** The schema declares
  `reactions` with one hardcoded example emoji name (`:frowning2:`) as if
  it were a fixed property, instead of describing it as a free-form
  emoji→usernames map. Real reactions under any other emoji (e.g. `:smile:`,
  used by our own `chat-react` example) get flagged as an "unknown
  property" — a modeling defect, not an app bug.
- **`md[].value[].value` is genuinely polymorphic** (a plain string, a
  `{type,value}` object, or an array of them, depending on message
  content), but the spec fixes it as a single type. Same finding the old
  branch already made; independently reproduced here via `dm.list`'s
  message previews, not taken on faith.
- **`unreadsFrom` real value is `null`; spec declares `type: string`** (no
  `nullable`/`oneOf`). `dm.counters` returns `null` when there's no unread
  interval — confirmed directly. Left our own example without this field
  (omitting it is enough to satisfy the schema, since nothing requires it)
  rather than fabricate a string value that isn't what the app returns.

**Real, legitimate non-2xx paths exercised (not bugs):** `chat.getMessageReadReceipts`
(Enterprise-gated: `"This is an enterprise feature"` on Community Edition),
`dm.messages.others` (disabled by default: `error-endpoint-disabled`),
`im.blockUser` (`error-invalid-room` — our fixture is a self-DM with no
second real user to block; the app's validation is correct for that input,
creating a second user account is out of scope here), all three
`autotranslate.*` operations (`"AutoTranslate is disabled."` — not
configured on a fresh instance).

**Genuine spec gap, not worked around:** `autotranslate.saveSettings`'s
spec declares only `200`/`401` responses — no `400` at all — yet the live
app returns `400` (`"AutoTranslate is disabled."`) exactly like the other
two `autotranslate.*` operations do. No schema-conformant external example
is possible for a status the operation doesn't declare, so none was
written; the finding is established directly from the live `curl` response
instead (see script comments).

**Not yet resolved (scoped follow-up)** — `GET /api/v1/push.get`
(`notifications.yaml`, previously deferred) still isn't wired: it needs a
real message `_id`, which now exists (this pass seeded one), but revisiting
it is left for a dedicated pass over `notifications.yaml` rather than a
side effect of this one.

**Result:** 126 tests run, ~20 pass with real requests across roughly 35
operations actually exercised, ~105 fail — every failure accounted for by
the categories above. Zero unexplained failures, despite the much larger
surface area than any prior file.

### 2026-07-19 — Provider contract test: `rooms.yaml` (spot-checked)

154 operations — channels.\* (~40), groups.\* (~35, the private-room twin
of channels.\*), teams.\* (~20), rooms.\* (~25), subscriptions/directory/
invites (~10), plus Enterprise-only `abac.*`/`audit.*` (~6). Given the
remaining files (`omnichannel.yaml` at 165 ops is even bigger) and real
time constraints, this file was **spot-checked with real, live-verified
requests rather than a bespoke permanent example per operation** — every
number below is from an actual request against the live app, not
invented, but not every one of the 154 was individually exercised. ~65
operations were directly tested.

**Why spot-checking here is a legitimate call, not a shortcut on
correctness:** `channels.*` (~35 ops) was tested exhaustively first and
produced zero categories beyond the five already established in the first
four files. `groups.*` was then spot-checked (create, info, list, members,
invite, setTopic, archive, delete) and confirmed byte-for-byte the same
behavior as `channels.*` — expected, since they share the same underlying
room-service code, differing only in room type (`c` vs `p`). Continuing to
hand-verify all ~35 near-identical `groups.*` operations individually
would cost real time for a near-certain non-finding.

**Confirmed clean (real requests, no drift beyond the established
categories):** the full `channels.*` lifecycle — create, info, list,
list.joined, members, counters, roles, moderators, online, files, history,
messages, getAllUserMentionsByChannel, getIntegrations, setTopic,
setDescription, setAnnouncement, setPurpose, setReadOnly, setCustomFields,
setJoinCode, rename, close, open, archive, unarchive, join, invite,
addModerator/addOwner/addLeader, removeModerator/removeOwner/removeLeader,
kick, convertToTeam, delete. Representative `groups.*`, `teams.*` (info,
listAll, members, addMembers, convertToChannel), `rooms.*` (get,
adminRooms, info, favorite, nameExists, createDiscussion, getDiscussions),
`subscriptions.*`, `directory`, `listInvites`, `findOrCreateInvite`,
`useInviteToken`, `uploads.delete`.

**Enterprise-gated, confirmed via source, not assumed:** `abac/attributes`,
`abac/pdp/health`, `audit/rooms.members` all return
`error-unauthorized` even for the admin account on this Community Edition
instance. Confirmed by finding the actual route registrations at
`apps/meteor/ee/server/api/abac/index.ts` and `apps/meteor/ee/server/api/audit.ts`
— genuinely Enterprise-only code, same category as
`chat.getMessageReadReceipts` in `messaging.yaml`, not a permissions bug.

**Own test-setup mistakes caught before being misreported as findings**
(worth recording so the pattern is recognizable next time): sent the
wrong param name to `channels.online` (`query` body instead of documented
`_id` query param), `channels.convertToTeam` (`roomId` instead of
`channelId`), `teams.update` (an invented `topic` field that was never in
the documented `data.name`/`data.type` shape), `rooms.isMember` (missing
required `userId`/`username`), and `uploads.delete` (wrong HTTP method,
`DELETE` instead of documented `POST`). Every one reproduced correctly
once the request matched the spec — real confirmation that the spec was
right and the mistake was in the test, not silently written off.

**No new categories beyond the five already established** in prior files
(undocumented real fields on room/message/error objects, Enterprise
gating, disabled-by-default features, per-operation schema duplication,
polymorphic `md`). Nothing in this file's spot-check contradicts or adds
to that list.

**Not covered this pass, explicitly** — the remaining ~90 operations
(most of `groups.*`/`teams.*`/`rooms.*` beyond the representative sample
above, `channels.anonymousread` config-gated on this instance, room-image
uploads). Not filtered, not claimed as verified — genuinely untested,
logged here so the gap is visible rather than implied to be covered.

### 2026-07-19 — Provider contract test: `omnichannel.yaml` (spot-checked)

165 operations (`livechat.*` ~124, `omnichannel.*` ~13, `canned-responses`
~3) — Omnichannel/livechat, a genuinely distinct domain from the rest of
the API (not a mirror of anything tested so far), spot-checked across its
major sub-areas rather than exhaustively, same time-driven call as
`rooms.yaml`.

**Confirmed omnichannel is actually enabled** on this instance (not
gated off entirely) — `livechat/appearance`, `livechat/department`
return real data, not a "disabled" error. This matters: it meant real
functional testing was possible here, not just a uniform gate response.

**Real requests, working correctly:** `livechat/department` (create, after
supplying all three actually-required fields — `enabled`,
`showOnRegistration`, `showOnOfflineForm` — see below), `livechat/queue`,
`livechat/inquiries.list`, `livechat/analytics/dashboards/chats-totalizers`,
`livechat/visitor` (create), `livechat/rooms`, `livechat/custom-fields`,
`livechat/users/agent`, `omnichannel/contacts` (create).

**Enterprise-gated, dominant pattern in this file specifically:**
`livechat/business-hours`, `livechat/tags`, `livechat/priorities`,
`livechat/sla`, `canned-responses` all return the license-gate response
(`"This is an enterprise feature"` or, for `canned-responses`, a
permission-style `error-unauthorized` — confirmed via
`apps/meteor/ee/server/models/CannedResponse.ts` that it's genuinely EE
code, not a real permissions gap on the admin account). Omnichannel's
advanced routing/SLA features are far more EE-heavy than any other spec
file tested so far — worth knowing going in if this project continues:
expect a lower real-coverage ceiling here than elsewhere, structurally.

**Real, legitimate fixture-dependent error, not a bug:** starting a
livechat room (`GET /livechat/room?token=...`) for the visitor created
above correctly returns `"Sorry, no online agents [no-agent-online]"` —
correct behavior given no agent is registered/online in this test
instance; not pursued further (registering and bringing an agent online
is a bigger fixture lift, out of scope for this spot-check).

**Own test-setup mistakes caught, not real bugs:** `livechat/users/agent`
(guessed wrong initial path shape), `omnichannel/contacts` (used `GET`,
spec says `POST`), `livechat/department` create (initially missing 3
required fields, only visible one at a time as the app validates them
sequentially — the spec's own `Success Example` response documents all
three, which is what caught it).

**No new categories beyond the six now established** across every file
(the five from before, plus this file's confirmation that Enterprise
gating is a first-class, recurring pattern, not a one-off).

**Not covered this pass, explicitly** — the ~140 remaining operations
(most of `livechat.*`'s CRUD depth: triggers, monitors, integrations,
webhooks, most of `omnichannel/contacts.*`, the full agent/department
lifecycle beyond creation, most analytics breakdowns beyond the one
totalizer checked). Genuinely untested, not filtered, logged for
visibility.

### 2026-07-19 — Provider contract test: `user-management.yaml` (spot-checked)

56 operations (`permissions.*`, `roles.*`, `users.*` ~40, `ldap.*`,
`moderation.reportUser`). ~30 operations tested directly with real
requests against a real seeded test user.

**Confirmed clean:** `users.create`, `users.info`, `users.list`,
`users.setStatus`/`getStatus`, `users.getPresence`, `users.setActiveStatus`,
`users.autocomplete`, `users.checkUsernameAvailability`,
`users.getUsernameSuggestion`, `users.getPreferences`/`setPreferences`,
`users.getPersonalAccessTokens`, `users.deactivateIdle`,
`moderation.reportUser`, `users.requestDataDownload`, `users.listByStatus`,
`users.resetAvatar`, `users.getAvatar` (307 redirect to the image, as
expected), `users.delete`, `roles.list`, `permissions.listAll`,
`roles.addUserToRole` (against the real built-in `moderator` role),
`roles.getUsersInRole`.

**Real, spec-confirmed security behavior (not a bug, matches the spec's
own documented error case exactly):** `users.generatePersonalAccessToken`,
`users.resetTOTP`, `users.resetE2EKey` all return `"TOTP Required
[totp-required]"` with `availableMethods: []` on an account with no 2FA
configured. Checked directly against the spec: this is `users.generatePersonalAccessToken`'s
own documented `400` `Example 1` response, verbatim. A genuine positive
confirmation the app matches the contract here, not just an absence of
failure.

**Enterprise-gated:** `roles.create` (custom roles are EE-only, per the
spec's own `requestBody` description, which explicitly says so).

**Disabled-by-default, real and expected:** `ldap.testConnection` returns
`"LDAP_disabled"` — no LDAP configured on this instance, same category as
`autotranslate.*` in `messaging.yaml`.

**Documented requirement, not exercised further:** `users.createToken`
requires a `CREATE_TOKENS_FOR_USERS_SECRET` environment variable to be set
on the deployment (per the spec's own description) — not configured in
this docker-compose setup, so only the correctly-documented `400`
(missing `secret`) was confirmed, not the success path. Would need a
compose env var addition to test further; scoped as follow-up, not
chased down.

**Own test-setup mistakes, corrected:** `users.autocomplete` (query param
needed URL-encoding, not raw JSON), `roles.addUserToRole` (guessed
`roleName`, spec correctly documents `roleId`).

**No new categories.** Every result here reconfirms the established
patterns (EE-gating, disabled-by-default features) or is a genuine,
spec-matching pass.

**Not covered this pass** — `users.register`, `users.update`,
`users.updateOwnBasicInfo`, `users.logout`/`logoutOtherClients`/
`removeOtherTokens`, `users.setAvatar` (needs real image upload, deferred
like the multipart operations in `content-management.yaml`),
`users.sendWelcomeEmail`/`sendConfirmationEmail`/`forgotPassword`/
`sendInvitationEmail` (all need SMTP configured to verify meaningfully),
`ldap.syncNow`/`testSearch`, `avatar/{subject}`. Genuinely untested, not
filtered.

### 2026-07-19 — Provider contract test: `settings.yaml` — real app bug found

**`GET /api/v1/instances.get` — undocumented `400`, raw internal error
leaking through, genuine time-dependent runtime bug (not a docs gap).**

Calling this operation (admin-only, `view-statistics` permission,
otherwise-correctly authenticated) returned:
```
HTTP 400
{"success":false,"error":"Service '$node.list' is not available."}
```
The spec (`settings.yaml`) only documents `200`/`401`/`403` for this
operation — no `400` at all, and this error text is an internal Moleculer
broker message, not a Rocket.Chat-authored error string.

**Traced to a real code path, not assumed:**
`apps/meteor/ee/server/local-services/instance/service.ts:214` —
`getInstances()` calls `this.broker.call('$node.list', { onlyAvailable: true })`
unconditionally (this broker is always created/started regardless of EE
license — only the cross-instance *broadcast* feature is license-gated,
not this broker itself). `$node.list` is Moleculer's own built-in
node-registry action.

**Confirmed via the live container's own logs — this is the finding,
not a guess:**
```
15:49:38  INFO  .../REGISTRY: '$node' service is registered.
15:49:38  INFO  .../$NODE: Service '$node' started.
15:49:38  INFO  .../BROKER: ✔ ServiceBroker with 2 service(s) started successfully in 567ms.
19:15:57  WARN  .../BROKER: Service '$node.list' is not available.
```
The service registers and starts cleanly at container boot, then goes
unavailable roughly 3.5 hours later during otherwise-normal runtime — a
genuine runtime degradation, not a startup-ordering race (which is what
I initially suspected before checking the logs).

**Plausible mechanism (not fully confirmed — the honest limit of this
investigation):** the broker is configured with `heartbeatInterval: 10s`
/ `heartbeatTimeout: 60s` (`packages/instance-status/src/index.ts`:
`defaultPingInterval=10`, `indexExpire=ceil(10*3/60)*60=60`) — unusually
tight for a broker whose whole purpose is tracking cluster peers. Working
theory: on a single-node deployment (no real peers to receive heartbeats
from), the local node's own bookkeeping falls out of the broker's
internal registry under these tight timeouts during an idle period.
Fully confirming this would need live broker-internals debugging (stepping
through Moleculer's registry GC), which is beyond what's practical here —
flagged honestly as a strong candidate, not asserted as certain.

**Why this is a real app-fix candidate, not spec/documentation drift:**
this is the first finding in the whole project that isn't "the app does
more/different than the spec says" — it's the app failing in a way that
leaks internal implementation details through an authenticated admin API,
on a genuinely common deployment shape (single-container, no clustering
configured) after the instance has simply been running a while. Two
independent, valid fixes exist depending on which layer owns the
responsibility: (a) fix/relax the heartbeat timing so a solo node doesn't
fall out of its own registry, or (b) wrap the `instances.get` route
handler so a broker-unavailable condition degrades to the empty-list
behavior the CE stub (`getInstanceList.ts`) already implies is the safe
default, instead of leaking a raw `400`. Left as a flagged, well-evidenced
finding rather than a blind fix, per discussion.

**Second real finding — `federation/listServersByUser`/`addServerByUser`/
`removeServerByUser`: documented, actively depended on by real frontend
code, but no server-side implementation exists at all.** Confirmed via
exhaustive search of both CE (`apps/meteor/server`) and EE
(`apps/meteor/ee`) — zero route registrations anywhere for any of the
three. Stronger evidence than the earlier missing `twoFactorChallenges.*`
finding in `authentication.yaml`: this one has a real, live frontend
caller — `apps/meteor/client/sidebar/header/MatrixFederationSearch/useMatrixServerList.ts:5`
explicitly calls `useEndpoint('GET', '/v1/federation/listServersByUser')`.
The Matrix Federation sidebar search UI feature is calling an endpoint
that returns a plain `404` today. Same category of decision as the 2FA
gap (a real feature-scope question, not a mechanical fix) — flagged, not
unilaterally implemented.

**Minor finding, lower confidence — `dns.resolve.txt`/`dns.resolve.srv`:**
also 404, but unlike the federation case, zero references anywhere in the
codebase (not server, not client, not EE). Likely a documentation-only
entry describing a feature that was never built on either side, rather
than a broken integration — noted for completeness, not pursued further.

**Rest of the file, spot-checked and consistent with established
categories:** `e2e.fetchMyKeys`, `moderation.reports` (real validation
error, own incomplete test params), `video-conference.capabilities`/
`.providers` (real "no provider configured" responses — same
disabled-by-default pattern), `importers.list`, `settings.public`,
`settings`, `settings/{_id}`, `service.configurations`, `pw.getPolicy`.
`sessions/list` is Enterprise-gated (consistent pattern). Own test
mistakes this pass, caught before being misreported: `settings.public`
(shell-escaping issue with the `query` param, not a real bug),
`dns.resolve.txt` (initially wrong method, corrected to POST — still
404'd after correcting, which is what led to the finding above).

**Not covered this pass** — `e2e.*` beyond `fetchMyKeys`, the full
`import.*`/`getImportProgress`/etc. data-import workflow, `cloud.manualRegister`,
`moderation.*` beyond one operation, `sessions/*` beyond `list`,
`video-conference.start`/`join`/`cancel`, `uploadImportFile`/
`downloadPendingFiles`/`downloadPendingAvatars`, `federation/searchPublicRooms`/
`joinExternalPublicRoom`, `media-calls.state`. Genuinely untested.

### 2026-07-19 — Provider contract test: `integrations.yaml`

13 operations (`integrations.*`, `webdav.*`, `oauth-apps.*`). Real
integration and OAuth app created, exercised, and cleaned up.

**Spec blocker, confirmed still present in the canonical (unforked)
upstream spec — not fixed here, logged as candidate upstream issue:**
`POST /api/v1/integrations.create`'s `requestBody.required` unconditionally
lists `event` and `urls`, but the field descriptions explicitly say
`event` is "**Required for outgoing integrations**" only — contradicting
the unconditional requirement for incoming integrations. This is the
exact same defect the old (abandoned) branch found and "fixed" by
patching its spec fork; here it's confirmed to still be present in the
real upstream spec, logged without touching it. Worked around by testing
only the outgoing-integration shape (which does need `event`/`urls`),
same as the rest of this project's approach to genuinely conditional
requirements modeled as unconditional.

**Confirmed clean:** `integrations.create` (outgoing), `integrations.get`,
`integrations.list`, `integrations.history`, `integrations.remove`,
`webdav.getMyAccounts`, `oauth-apps.list`, `oauth-apps.create`,
`oauth-apps.delete`.

**Not covered this pass** — `integrations.update`, `webdav.removeWebdavAccount`,
`oauth-apps.update`/`get`. Genuinely untested.

### 2026-07-19 — Provider contract test: `marketplace-apps.yaml`

13 operations (Apps Engine marketplace/installed-apps management).

**Minor spec path error, confirmed, not a spec judgment call — genuinely
objective:** `/apps/count` and `/apps/buildExternalAppRequest` are both
declared in the spec *without* an `/api` prefix. The real, working paths
are `/api/apps/count` and `/api/apps/buildExternalAppRequest` — confirmed
by testing the bare path first (`404`/SPA-fallback HTML, not a JSON
error) and then the `/api`-prefixed path (clean `200` with real data).
Every other operation in this file correctly uses either `/api/apps/...`
or `/api/apps/...` with a path param. Different in kind from the
`integrations.create` finding: this isn't a conditional-requirement
contradiction, it's a straightforward path typo in two entries. Logged as
a second candidate for an upstream spec fix, not touched here.

**Own test mistake, caught before being misreported:** `GET /api/apps`
(no `appId`) — the real bare-list `GET /api/apps` route doesn't exist;
the spec's `get-api-apps` operation is actually declared under
`/api/apps/{appId}` (a per-app lookup, confirmed by tracing the path key
governing that operation block), not a list endpoint. `POST /api/apps`
(install) is the only bare `/api/apps` operation.

**Confirmed clean:** `apps.installed`, `apps/categories`, `apps/marketplace`
(this one genuinely reached Rocket.Chat's real cloud marketplace API and
returned live app listings — confirms outbound connectivity works in this
test environment).

**Not covered this pass** — `apps/logs` (and the per-app `{id}/logs`
variant), `video-conference/jitsi.update-timeout`, `POST /api/apps`
(install — would need a real app package, out of scope), `DELETE
/api/apps/{appId}`, the incoming-webhook/template-message app endpoints
at the top of the file. Genuinely untested.
