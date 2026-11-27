# Decisions

## Built
- **Webhook**: HMAC check on the raw body, a ±5 min timestamp window, then an idempotent insert keyed by `workspace:message_id`. We answer `2xx` only after MongoDB has the write; if storage fails we answer `503` and Pigeon retries. Unknown type or unknown workspace → `200` (ignored); unparseable body → `400`; bad or missing signature → `401`.
- **Replies**: a transactional outbox in MongoDB keyed by `workspace:client_ref`, so the same ref twice is one row. Every server copy runs a worker that takes a job with a 20 s lease. If a copy dies, another takes the job once the lease runs out (well inside 60 s). Every send carries `Idempotency-Key = workspace:client_ref`, so retrying after a timeout or crash never sends twice. Rate limit: one Redis token bucket per workspace, shared by all copies (6 burst, 3/s, deliberately below Pigeon's 8 / 4/s), plus a shared cool-off key set from `Retry-After`; a 5xx also cools the workspace off for 1 s.
- **Status** only moves forward (`rank` condition in the update), so `delivered` arriving before `sent` holds. A status for a `client_ref` we never sent is ignored.
- **Claim** is one conditional upsert (`assignee` is null or me); the loser of the race hits a duplicate key → `409`.
- **Real time**: `seq` comes from Redis `INCR` per workspace; frames are stored in MongoDB; a Redis publish wakes every copy. Each socket *pulls* `seq > last` from MongoDB in order, so it never reorders, and `after=N` replay is the same code path.
- **Auth**: OIDC code + PKCE, with state and verifier in Redis (login and callback may land on different copies). Sessions live in Redis behind an httpOnly SameSite=Lax cookie. Workspaces and roles come from `/userinfo`.
- **Frontend**: login, workspace switcher, open/closed/all filter, paginated list, thread, claim/release/close/reopen, reply with live status, auto-reconnecting socket with `after=`. Replies use a `client_ref` made in the browser, so a retried POST is still one reply.

## Cut, and why
- **Encrypted notes, search, billing**: lower value per minute than the 85 points from the check. No `PROTOCOL.md`.
- **Admin vs agent**: roles are stored and shown, but nothing is admin-only yet.

## Assumptions where the brief is silent
- A new inbound message reopens a closed conversation; a reply does not.
- `POST /__grader/reply` to an unknown workspace → `404`; missing fields → `400`.
- Messages in a thread are ordered by `occurred_at` (inbound) and send time (our replies).
- Any other Pigeon 4xx on send (not 429) is final → `failed`.

## Known to be wrong or weak
- **Lost status frames on crash**: if the process dies between storing a status or claim and storing its realtime frame, that frame is lost (the data is right; only the live push is missing). Inbound messages are covered by a `framed` flag; status and claim frames are not.
- **Gap skip**: a socket waits 2 s for a missing `seq` (taken by INCR but not yet stored), then skips it. A frame stored later than that is never pushed to that socket.
- **`seq` lives in Redis**: if Redis loses its data, `seq` restarts and clients reconnecting with an old `after=` miss frames. It could be rebuilt from the highest `seq` in MongoDB at boot.
- **No CSRF token**: we rely on SameSite=Lax plus JSON bodies. The id_token signature is not verified; identity comes from userinfo over the server-to-server channel.
- After `/__grader/reset`, already-open sockets keep their old `last` and stay silent until they reconnect.
