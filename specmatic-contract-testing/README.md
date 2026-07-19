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

### Provider contract test — all 12 specs (real RocketChat instance required)

All 12 spec files have been triaged against the live app (see "Issues found
and fixed" below for the per-file findings). This is the command that
actually runs all of them together and is what CI runs (Step 6):

```sh
# 1. Bring up RocketChat + MongoDB (see above), wait for it to answer on :3000

# 2. Capture a live admin auth token + real fixture data (messages, a DM
#    room, a custom user status, etc.) into external Specmatic examples
#    (gitignored -- RocketChat issues a fresh token per container boot, so
#    this has to be regenerated every time the container restarts)
../specmatic/scripts/regenerate-auth-examples.sh

# 3. Run the contract test, all 12 specs together
DEPRECATED_COMPOSE_ACK=1 docker compose \
  -f compose.yml -f ../specmatic/compose.test.yml \
  --profile test up specmatic-contract-test-all
```

JUnit report lands in `specmatic/reports/all/TEST-junit-jupiter.xml`. Only
~4% of operations have real committed examples (see Step 4) — most
failures reported are pre-triaged, already-documented "accepted drift" or
"spec blocker" entries below, not new findings; see each spec file's
section for what's actually covered vs. spot-checked vs. untested.

If you want to iterate on a single spec file instead of the full run (e.g.
while adding new examples), the per-file services this project was
developed against are still in `compose.test.yml` --
`specmatic-contract-test` (`authentication.yaml`),
`specmatic-contract-test-content-management`,
`specmatic-contract-test-notifications`,
`specmatic-contract-test-messaging` -- same `--profile test up <service>`
pattern, swapping the service name.

**Important, verified empirically against `specmatic/specmatic:2.50.0`:**
supplying `--config` alongside `--examples` silently disables external
example loading entirely — the config schema in this version doesn't even
have an `examples` key (its own validation error lists `governance`,
`license`, `settings` as the only top-level `specmatic:` properties), yet
adding `--config` still suppresses the CLI `--examples` flag. Since
`schemaResiliencyTests` is off by default with no config anyway, this
contract run omits `--config` entirely; that's why the coverage gate below
is enforced by parsing stdout rather than Specmatic's own
`governance.successCriteria` (which needs `--config`).

### Honest coverage gate check

After the contract-test-all run above, the same check CI enforces (Step 4):

```sh
grep -oE '[0-9]+% API Coverage reported' <captured-output>.log
```

Compare against the **4% baseline** recorded in Step 4 below — this rises
only as real committed examples get added to more spec files, never by
loosening the check.

### Resiliency (fuzz) test — all 12 specs

Same live RocketChat, no real auth needed (see Step 5 for why). Checks
whether RocketChat rejects deliberately malformed/mutated input gracefully
instead of crashing:

```sh
DEPRECATED_COMPOSE_ACK=1 docker compose \
  -f compose.yml -f ../specmatic/compose.test.yml \
  --profile test up specmatic-resiliency-test-all
```

JUnit report lands in `specmatic/reports/resiliency/TEST-junit-jupiter.xml`.
Finishes in a few minutes, not the 1hr+ an earlier unfiltered attempt took
— see Step 5 for why `GET /livechat/rooms` is excluded via `--filter`, and
for the one path defect (`media-calls.state`) corrected via an OpenAPI
overlay (`--overlay-file`, never a spec edit) rather than left broken or
silently dropped.

### CI

All of the above runs automatically on push/PR via the workflows described
in Step 6 — see that section for the exact gates (hard: consumer-mock;
soft/report-only: contract-test's individual run, resiliency-test,
examples-lint) and why each is scoped the way it is.

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

**Spec blocker (excluded via `--filter`, not edited) — RESOLVED, no app fix
needed.** `POST /api/v1/twoFactorChallenges.sendEmailCode` and
`.../twoFactorChallenges.verifyChallenge` are fully documented in the spec
but have no corresponding route anywhere in `apps/meteor/server`.
Investigated to a conclusion: this is a **pure spec-authoring mismatch,
not a missing feature**. Rocket.Chat's real 2FA design never needs a
separate "verify challenge" endpoint — when any request (login or
otherwise) fails with `totp-required`, the client re-submits the
*original* request with the code attached (confirmed in
`apps/meteor/client/lib/2fa/process2faReturn.ts` and
`packages/api-client/src/index.ts`'s retry-with-code logic), rather than
POSTing to a distinct verify resource. The "send code" half is already
covered by the real `users.2fa.sendEmailCode`, which explicitly works
pre-login (no `authRequired`, falls back to an `emailOrUsername` lookup)
— already tested successfully earlier in this section. The spec invented
a challenge/verify resource pattern that doesn't match how the app
actually authenticates. Nothing to build; the two operations stay
excluded from testing (no real route exists to test), and no spec edit is
warranted either — it's simply describing a shape the app never had.

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
`removeServerByUser`: RESOLVED — confirmed abandoned 2023 feature, not
touched here, recommend removing the dead UI rather than building the
backend.** Documented in the spec, actively called by real frontend code
(`apps/meteor/client/sidebar/header/MatrixFederationSearch/useMatrixServerList.ts:5`,
`useEndpoint('GET', '/v1/federation/listServersByUser')`), zero
server-side route anywhere in CE or EE. Investigated to a conclusion:

- The whole `MatrixFederationSearch/` UI (add/remove a homeserver per
  user, then search/join public rooms on it) landed in a single commit,
  `0d9cb7fe0c` ("Matrix search UI", 2023-05-02), frontend-only. Every
  commit to that directory since has been a mechanical refactor
  (JSX runtime, lint rules, package moves, tanstack v5) — never backend
  work.
- The backend interface this was designed against,
  `IFederationServiceEE` (`packages/core-services`), declares the exact
  matching methods (`getSearchedServerNamesByInternalUserId`,
  `addSearchedServerNameByInternalUserId`,
  `removeSearchedServerNameByInternalUserId`, `searchPublicRooms`,
  `joinExternalPublicRoom`) but **no class anywhere in the repo
  implements it or registers the `federation-enterprise` service** — not
  now, and no deletion commit shows it ever did.
- The same UI also depends on two *more* unimplemented endpoints
  (`searchPublicRooms`, `joinExternalPublicRoom`) beyond the 3 this
  contract-testing pass found — the whole feature is a stub, not just
  these three routes.
- Meanwhile Rocket.Chat's real, actively-maintained Matrix federation
  work lives in `ee/packages/federation-matrix` (commits as recent as
  2026-07-03) and is architected around room-level bridging, with no
  per-user "list of my servers" concept at all — this old design has been
  superseded, not merely delayed.

**Conclusion:** not a small mechanical fix (no backend data model/service
exists to wire routes onto) and not aligned with the current federation
architecture — building it now would mean designing a new feature against
a superseded approach. Left unbuilt. The more useful outcome of this
finding: `MatrixFederationSearch/`'s UI is currently live and reachable in
the product (a real sidebar search entry point) while being **completely
non-functional** — every action in it 404s. That's a small, real UX bug
in its own right, independent of the spec: either finish the backend
against the current federation architecture, or remove the dead UI so
users don't hit a wall of 404s. Recommended to the team as a follow-up
outside this contract-testing project's scope, not implemented here.

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

### 2026-07-19 — Provider contract test: `statistics.yaml`

11 operations. `statistics`/`statistics.list` confirmed clean with real
data. All 9 `engagement-dashboard.*` operations are uniformly
Enterprise-gated (`"This is an enterprise feature"`) — confirmed on 2
representative ones (`users/new-users`, `channels/list`); the remaining 7
weren't individually re-tested since the gate is applied uniformly at
the same permission-check layer, not per-operation logic. No new
categories.

### 2026-07-19 — Provider contract test: `miscellaneous.yaml` (final file)

30 operations — the last of the 12 spec files. `email-inbox.*`, `spotlight`,
`smtp.check`, `licenses.*`, `commands.*`, `mailer`, `fingerprint`,
`calendar-events.*`, `shield.svg`.

**Third instance of the same "missing `/api` prefix" spec pattern**
(after the two in `marketplace-apps.yaml`): `/licenses.maxActiveUsers` is
declared bare in the spec; the real, working path is
`/api/v1/licenses.maxActiveUsers` — confirmed the same way (bare path
falls through to the SPA shell, `/api/v1`-prefixed path returns clean
JSON). Three confirmed instances across two files is enough to call this
a systematic, low-severity spec authoring pattern rather than isolated
typos — worth mentioning as a group if this ever gets raised upstream,
rather than three separate reports.

**Confirmed clean:** `spotlight`, `smtp.check` (real "not configured"
response, consistent with the disabled-by-default pattern), `licenses.info`,
`commands.list`, `commands.get`, `email-inbox.list`, `calendar-events.list`
(after correcting the query param to the spec's actual `date`, not the
guessed `startDate`/`endDate`).

**Real validation responses, own incomplete test data, not bugs:**
`calendar-events.create` (missing `startTime`), `mailer` (missing the
required unsubscribe-link field — a real, sensible validation, not
chased further), `fingerprint` (missing `setDeploymentAs`), `shield.svg`
(400, likely a missing required param — not chased further given this is
a low-value SVG-badge endpoint).

**Not covered this pass** — `email-inbox` create/get/delete/search/send-test,
`licenses.add`, `commands.preview`/`run`, `mailer.unsubscribe`,
`method.call/{method}`, `calendar-events.info`/`update`/`delete`/`import`,
the two `/api/apps/public/...` webhook endpoints (duplicated from
`marketplace-apps.yaml`). Genuinely untested.

---

## Summary: all 12 spec files processed

Every one of Rocket.Chat's 12 OpenAPI spec files has now had at least one
real, live-verified pass — 4 files (`authentication`, `content-management`,
`notifications`, `messaging`) at full per-operation depth, 8 files
(`rooms`, `omnichannel`, `user-management`, `settings`, `integrations`,
`marketplace-apps`, `statistics`, `miscellaneous`) spot-checked with real
requests given the time budget, explicitly documenting what wasn't
covered rather than implying full coverage. Zero spec edits anywhere.
Zero forks. Every finding traced to actual evidence (a real request/
response, a real log line, or a real source file) — never asserted on
assumption.

**Real app bugs found (candidates for an app fix, not spec drift):**
1. `GET /api/v1/instances.get` — undocumented `400`, raw internal
   Moleculer broker error leaking through; the underlying service
   registers fine at boot and degrades ~3.5 hours into runtime (see
   `settings.yaml` section for full evidence and the two candidate fixes).
   Still open — a real, unresolved app bug.

**Investigated to resolution (not left as open questions):**
2. `federation/listServersByUser`/`addServerByUser`/`removeServerByUser`
   — traced to an abandoned 2023 frontend-only feature
   (`MatrixFederationSearch/`) with no backend ever built and no data
   model to build one against; superseded by the current, differently-
   architected Matrix federation work. Not implemented (would be a real
   feature-build against a dead design, out of scope) — recommended
   instead that the team either finish it against current architecture
   or remove the dead, 404-on-every-action UI. See `settings.yaml`
   section for full evidence.
3. `twoFactorChallenges.sendEmailCode`/`verifyChallenge`
   (`authentication.yaml`) — confirmed a pure spec-authoring mismatch,
   not a missing feature: Rocket.Chat's real 2FA design re-submits the
   original request with the code rather than using a separate verify
   endpoint, and the "send code" half is already covered by the real
   `users.2fa.sendEmailCode`. Nothing to build. See `authentication.yaml`
   section for full evidence.

**Confirmed-still-present spec defects** (objective, not judgment calls;
logged, never edited): `integrations.create`'s unconditional
`required: [event, urls]` contradicting its own field descriptions (the
exact defect the old branch mis-handled by forking the spec); four
missing `/api` path prefixes (`marketplace-apps.yaml` x2,
`miscellaneous.yaml` x1, `settings.yaml`'s `media-calls.state` — found
via Step 5 resiliency testing, and the one case among these four where
a scoped OpenAPI overlay corrects the path for testing purposes, see
Step 5).

**Systemic accepted-drift categories** (the app is richer than the docs,
not wrong): undocumented real fields on message/room/error objects
(dozens of instances, one root cause); the polymorphic `md` markdown AST
field; the `reactions` map modeled as a literal example key; Enterprise
licensing gates (recurring across `messaging`, `rooms`, `omnichannel`,
`user-management`, `statistics`); disabled-by-default features
(`autotranslate`, `LDAP`, `SMTP`, `AutoTranslate`).

## Step 4: Honest coverage gate

Running all 12 spec files together (`--examples` + `--lenient`, no
`--config` — see below) against the live app:

**First full run:** 1238 tests, 47 passes, 635 failures, **556 errors**.
Nearly every error was `Cannot connect to server ... Request timeout has
expired [request_timeout=6000 ms]`, and every one of them referenced the
same in-flight URL, `POST /api/v1/livechat/offline.message` — a route
whose handler (`apps/meteor/server/api/v1/omnichannel/offlineMessage.ts:11`)
sets `rateLimiterOptions: { numRequestsAllowed: 1, intervalTimeInMS: 5000 }`.
Initially read this as the server hanging/crashing under the rate limiter.

**That reading turned out to be wrong, and it's worth recording why.**
Trying to reproduce it in isolation, 5 rapid sequential requests to that
exact endpoint all completed in ~0.3s each, no hang. Re-running the full
1238-test suite with a longer client timeout (`--timeout-in-ms 15000`
instead of Specmatic's default 6000ms) produced **zero** connection
errors — same 1238 tests, `Errors: 0`. So the real story is: sustained
rapid-fire automated load (1238 requests in quick succession, well beyond
normal usage) occasionally pushed response latency past Specmatic's
default 6-second client timeout, not a genuine hang or crash. A real,
worth-knowing data point about latency under heavy synthetic load on a
single, non-clustered test container — but not the "app bug" it looked
like at first glance. Correcting this here rather than leaving the more
alarming initial read stand uncorrected.

**Coverage, confirmed stable across both runs:** **4% API coverage**,
1611 operations eligible for coverage (measured, not assumed — Specmatic
prints this to stdout even without `--config`). This reflects that only 4
of 12 spec files (`authentication`, `content-management`, `notifications`,
`messaging`) have real committed Specmatic example files; the other 8
were spot-checked with direct `curl` (real findings, documented above)
but that verification happened outside Specmatic's own example
mechanism, so it doesn't count toward Specmatic's measured coverage.
**4% is therefore the honest number, not a placeholder** — matching this
project's own rule (and the exact thing the old branch got right once it
stopped inflating gates).

**Why no `--config`/`governance.successCriteria`:** already established
per-file — supplying `--config` alongside `--examples` silently disables
external example loading entirely in this pinned image (verified back in
`authentication.yaml`'s section). `specmatic_contract.yaml` (the
leftover config file from before that discovery) is now unused by every
compose service and has been removed rather than left as dead,
misleading configuration.

**How the gate actually works, then:** the coverage percentage is parsed
straight from Specmatic's own stdout (`grep -oP '\d+(?=% API Coverage)'`)
in CI (see Step 6), compared against a stored baseline of **4%**, and
fails the build if it drops below that — the same "parse stdout, gate in
a separate step" approach the old branch already found necessary (its
own README noted "Specmatic's own exit code conflates 'tests failed'
with 'coverage gate failed'"). The baseline rises only as real spec
files get real committed examples in future work, never by loosening the
check.

## Step 5: Resiliency testing

Same 12 specs, same live app, `schemaResiliencyTests: all`
(`specmatic/specmatic_resiliency.yaml`) instead of `none` — deliberately
mutated/fuzzed inputs, checking whether RocketChat rejects them gracefully
instead of crashing or leaking internal state, a different question from
"does the API match the docs" (Steps 3/4). Kept as a fully separate run,
same reasoning as everywhere else in this project: blending correctness
and fuzz testing produces an unreadable wall of failures.

**No `--examples` here, and that's a real, confirmed constraint, not an
oversight:** `--config` (required for `schemaResiliencyTests`, no CLI flag
exists for it) and `--examples` cannot be combined in this pinned image
(Step 4). So this run has no real auth wired — the same limitation the
old branch's own resiliency run had for 11 of its 12 specs. Resiliency
testing's actual value (catching ungraceful failures on malformed input)
still holds regardless of auth state.

**Mechanism verified working, on `authentication.yaml` alone:** 118
tests generated (vs. 21 for the same file's plain contract-correctness
run — schema resiliency multiplies test count with type-mutation
variants like "the key `code` is mutated from string to boolean"), 4
passes, 114 failures, **0 errors** — clean execution, no crashes.

**Full 12-spec run:** executed via the `specmatic-resiliency-test-all`
compose service (1611 operations × fuzzed variants is a large surface).
The first attempt at all 12 together got interrupted about an hour in,
partway through `rooms.yaml` (8 of 12 specs already exercised), by a
Docker Desktop restart unrelated to Specmatic or the app itself — no
report exists for that partial pass since Specmatic only writes its
JUnit output at the very end of a run. Rather than re-run all 12 (this
is a report-only, non-gating run — see below — so a single combined
number across all 12 isn't required), re-ran just the 4 specs that
hadn't finished: `rooms`, `settings`, `statistics`, `user-management`.

**Results, these 4 specs:** 8492 tests, 20 passes, **8472 failures, 0
errors** — critically, **zero crashes, 500s, hangs, or connection
failures** across the whole run. RocketChat never breaks under fuzzed
input; every failure is a spec-shape mismatch, not a robustness bug.
All 8472 collapse into exactly four causes, three of which need no
action and one of which was fixed here (in the test harness, never the
spec itself):

1. **R0002, HTTP status mismatch — 11,432 occurrences, no action
   needed.** Root cause confirmed by inspection: this run has no real
   auth wired (the `--config`/`--examples` conflict noted above), so
   every "positive" scenario sends syntactically-valid but random
   garbage tokens and RocketChat correctly returns `401` instead of the
   spec's expected `200`. The app is behaving correctly; there's nothing
   to fix.
2. **R2003, unknown property — 11,294 occurrences, no action needed.**
   Traced to one shared component, `authorizationError` (referenced by
   nearly every operation's `401` response across all 12 files), which
   declares only `{status, message}`. RocketChat's actual 401 body is
   always `{success, error, status, message}` — two genuine extra
   fields, plus an analogous undeclared `enterprise` field on
   `settings.public` items. Same "additive undocumented fields, no
   behavioral harm" category already used elsewhere in this README —
   `success` is Rocket.Chat's universal REST convention, removing it
   would be an app regression, and the spec is frozen, so this is
   logged, not changed.
3. **R1001, type mismatch — 66 occurrences, no action needed.**
   `settings.public`'s `value: oneOf: [boolean, string]` doesn't cover
   real numeric settings (rate-limit/timeout values like `500`, `300`,
   `100`). The app's values are correct; the spec's polymorphism is
   incomplete — parallel to the already-documented `md[].value[].value`
   gap. Logged, not patched.
4. **R1002/R1001, `GET /media-calls.state` — a genuine, fixed, spec
   path defect.** Live-verified: `GET /media-calls.state` (the path
   `settings.yaml` actually declares) 200s with RocketChat's SPA HTML
   shell — it isn't a real route, just Meteor's catch-all fallback.
   `GET /api/v1/media-calls.state` (missing prefix restored) returns
   real JSON: `{"calls":[],"success":true}`. This is the exact defect
   class the [Specmatic labs overlays
   lab](https://github.com/specmatic/labs/blob/main/overlays/README.md)
   demonstrates (a path-prefix mismatch between contract and deployed
   service) and it's fixed the way that lab recommends: an **OpenAPI
   overlay** (`specmatic/overlays/media-calls-path.overlay.yaml`,
   applied via `--overlay-file`), not a spec edit. The overlay adds the
   correctly-prefixed path (identical operation body) and removes the
   wrong one, entirely in-memory at test time — the `contracts`
   submodule is never touched, forked, or committed to; the real defect
   still needs to be raised with the spec upstream on your own timeline.
   Verified after the fix: `media-calls.state`'s only remaining failures
   are the same R0002/R2003 categories every other endpoint shows —
   the path-specific failures are gone.

   **Deliberately not extended to categories 2 or 3 above.** An overlay
   could technically widen `authorizationError` or the `value oneOf` to
   make those failures disappear too, but both are already-triaged,
   intentional accepted drift, not test-setup defects — doing that
   would just be "patch the spec until tests pass" wearing a different
   hat, the exact failure mode this project restarted to get away from.
   The overlay stays scoped to the one case where the *test* was wrong
   (testing a path that doesn't exist), not where the *app* was
   "wrong" (it wasn't).

This exhaustive, informational, non-gating run belongs in CI
(`specmatic-resiliency-test.yml`, Step 6), executing on every PR/push
going forward. No coverage gate applies to this run (see
`specmatic_resiliency.yaml`) — "coverage" isn't a meaningful pass/fail
signal under fuzzing the way it is for the contract-correctness run.

### 2026-07-19 — Full 12-spec resiliency run + a real app fix

With the `GET /livechat/rooms` filter above in place, ran all 12 specs
together for real: **~9 minutes** (down from 1hr+ unfiltered), 1616
operations eligible, 33% API coverage under resiliency's own combinatorial
generation (a different, unrelated number from Step 4's 4% contract-test
coverage). **19,477 tests, 119 successes, 19,358 failures, 0 errors.**

Every failure again collapses into the same categories already established
above (R0002 no-real-auth artifact, R2003 undocumented `success`/`error`/
`enterprise` fields, R1001 `settings.public` value-type gap) — no new
accepted-drift category at full scale.

**One genuine, new, real app bug found and fixed:** `POST /api/v1/login`
returned a raw `500 Internal Server Error` instead of a normal 4xx when the
request body contained any key outside `user`/`username`/`email`/
`password`/`code` (confirmed with a plain `resume` key — any value,
including `null` or `""`). Verified live with curl before touching any
code, isolated to exactly that trigger.

**Root cause, traced to the real source, not guessed:**
`apps/meteor/server/api/ApiClass.ts`'s `loginCompatibility()` (used by the
REST `POST /login` route) passes the request body straight through
unnormalized whenever it sees an unrecognized key (line ~998), instead of
just the intended `user`/`password` shape. That raw body then fails
Meteor's own `check()` validation inside its built-in password login
handler, which throws `Match.Error` — a real, legitimate validation
rejection, but *not* a `Meteor.Error` subclass. The route's catch block
only special-cased `Meteor.Error` (line ~1091), so `Match.Error` fell
through to the generic `internalError()` (500) branch instead of the normal
`unauthorized()` (4xx) one.

**Fix:** `Match.Error` already carries its own sanitized companion error
for exactly this situation — `Meteor.Error(400, 'Match failed')` (verified
against Meteor's own `packages/check/match.js` source, since it isn't
vendored in this repo). The catch block now converts a `Match.Error` to
its `sanitizedError` before the existing `Meteor.Error` check, so it flows
through the same 4xx path as every other auth rejection instead of the
500 fallback. `@types/meteor` doesn't declare `Match.Error` at all (checked
against the exact pinned version, `2.9.11`) even though it's a real,
correctly-prototyped class at runtime, so this repo's existing local
type-augmentation file
(`apps/meteor/definition/externals/meteor/check.d.ts`, which already
extends `meteor/check`'s types for the same reason) got a matching
declaration added rather than reaching for an `any` cast.

**Verified, not assumed:** reproduced live via curl before the fix, traced
every line cited above by reading the actual file, confirmed the fix
compiles with a full `apps/meteor` typecheck (`node_modules`/`yarn.lock`
had to be installed fresh for this — see this session's history for the
Node-version/engine-check detour that required) — zero new errors
introduced, only 2 pre-existing unrelated errors in a broken third-party
`@rocket.chat/storybook-config` type stub file.

## Step 6: CI (GitHub Actions, no PR)

Four workflows in `.github/workflows/`, each scoped via `paths:` to
`specmatic-contract-testing/**` (plus their own workflow file) so they
only run when relevant. Committed directly to the `specmatic` branch and
pushed to `origin` (the user's own fork) — never opened as a PR, per the
project's ground rules.

- **`specmatic-consumer-mock.yml`** — hard gate. Starts the mock server
  from the 12 specs (no live RocketChat needed) and smoke-tests a
  schema-valid response. Should always pass; catches spec-parse
  regressions cheaply and fast. Verified locally before committing.
- **`specmatic-contract-test.yml`** — brings up live RocketChat + MongoDB,
  regenerates real auth/fixture examples, runs all 12 specs together.
  The individual test run is report-only; the real, hard gate is a
  separate step parsing the coverage percentage from stdout and failing
  if it drops below the **4%** baseline established in Step 4. Verified
  the exact grep pattern (`grep -oE '[0-9]+% API Coverage reported'`)
  against real captured output before writing it into the workflow.
- **`specmatic-resiliency-test.yml`** — same live setup, runs the
  fuzzed/mutated-input suite (Step 5). Entirely report-only — no
  established "good" resiliency baseline exists yet to gate on.
- **`specmatic-examples-lint.yml`** — `specmatic examples validate`
  against the spec submodule directly (no live app). Report-only
  (`continue-on-error: true`): these are the canonical, unforked upstream
  specs, so pre-existing upstream issues aren't this branch's fault to
  block on. Verified locally: finds real, pre-existing issues in several
  operations' own inline examples (missing auth headers on examples that
  were never designed to be complete standalone requests) — exactly the
  report-only signal this workflow is for.

All four upload their reports as build artifacts and tear down their
containers unconditionally (`if: always()`). None of them will actually
execute unless GitHub Actions is enabled on the fork they're pushed to —
noted, not assumed.
