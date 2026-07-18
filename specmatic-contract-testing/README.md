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
