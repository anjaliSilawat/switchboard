// Outbound replies: a transactional outbox in MongoDB.
// 1. enqueueReply() stores {status: queued} under a unique id (workspace:client_ref)
//    and only then answers 202. Same client_ref twice = same row.
// 2. Every server copy runs the worker. A worker takes a job with a lease
//    (lockedUntil). If the copy dies, the lease runs out and another copy
//    takes the job.
// 3. Sends use Idempotency-Key = workspace:client_ref, so a retry after a
//    timeout (Pigeon may have accepted it already) never sends twice.
// 4. A per-workspace token bucket in Redis (shared by all copies) plus a
//    shared "cool-off until" key from Retry-After keep us inside the limit.
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { getRedis } from './redis.js';
import { col, isDupKey, touchConversation, type OutboundMsg } from './store.js';
import { emit } from './realtime.js';

const WORKER_ID = randomUUID();
const LEASE_MS = 20_000; // > send timeout, < 60 s failover budget
const SEND_TIMEOUT_MS = 8_000;
const MAX_INFLIGHT = 8;

export class UnknownWorkspace extends Error {}

export async function enqueueReply(workspace: string, contact: string, text: string, clientRef: string, author: string | null) {
  if (!(workspace in config.pigeon.apiKeys)) throw new UnknownWorkspace(workspace);
  const now = new Date();
  const doc: OutboundMsg = {
    _id: `${workspace}:${clientRef}`,
    workspace,
    contact,
    client_ref: clientRef,
    text,
    author,
    status: 'queued',
    rank: 0,
    createdAt: now,
    dispatched: false,
    attempts: 0,
    nextAttemptAt: now,
    lockedUntil: new Date(0),
  };
  let fresh = true;
  try {
    await (await col.outbound()).insertOne(doc);
  } catch (e) {
    if (!isDupKey(e)) throw e;
    fresh = false; // same client_ref again: it is already stored, still 202
  }
  if (fresh) {
    await touchConversation(workspace, contact, now, false);
    await emit(workspace, { type: 'message.status', contact, client_ref: clientRef, status: 'queued', text, author }).catch(() => {});
    kick();
  }
}

// --- shared rate limit -------------------------------------------------------
// Token bucket in Redis, atomic via Lua. A bit below Pigeon's 8 / 4 per s so
// clock skew between copies does not push us over.
const BUCKET_LUA = `
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2]); local now = tonumber(ARGV[3])
local cool = tonumber(redis.call('GET', KEYS[2]) or '0')
if cool > now then return cool - now end
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap; local ts = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - ts) * rate / 1000)
if tokens < 1 then
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now); redis.call('PEXPIRE', KEYS[1], 60000)
  return math.ceil((1 - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'ts', now); redis.call('PEXPIRE', KEYS[1], 60000)
return 0`;

// returns 0 if we may send now, otherwise ms to wait
async function takeToken(workspace: string): Promise<number> {
  const r = await getRedis().eval(BUCKET_LUA, 2, `bucket:${workspace}`, `cool:${workspace}`, 6, 3, Date.now());
  return Number(r);
}
async function coolOff(workspace: string, ms: number) {
  const until = Date.now() + ms;
  // keep the later of the existing and new cool-off
  await getRedis().eval(
    `local c = tonumber(redis.call('GET', KEYS[1]) or '0'); if tonumber(ARGV[1]) > c then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) end`,
    1,
    `cool:${workspace}`,
    until,
    ms + 1000,
  );
}

// --- worker --------------------------------------------------------------------
let inflight = 0;
let ticking = false;

async function lease(): Promise<OutboundMsg | null> {
  const now = new Date();
  return (await col.outbound()).findOneAndUpdate(
    { dispatched: false, nextAttemptAt: { $lte: now }, lockedUntil: { $lte: now } },
    { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS), lockedBy: WORKER_ID } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
}

async function release(job: OutboundMsg, set: Partial<OutboundMsg>) {
  // only the current lease holder may write back
  await (await col.outbound()).updateOne({ _id: job._id, lockedBy: WORKER_ID }, { $set: { ...set, lockedUntil: new Date(0) } });
}

const backoff = (attempts: number) => Math.min(5000, 500 * 2 ** attempts) + Math.random() * 300;

async function process1(job: OutboundMsg) {
  const wait = await takeToken(job.workspace);
  if (wait > 0) return release(job, { nextAttemptAt: new Date(Date.now() + wait) });

  let res: globalThis.Response;
  try {
    res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.pigeon.apiKeys[job.workspace]}`,
        'idempotency-key': job._id,
      },
      body: JSON.stringify({ to: job.contact, text: job.text, client_ref: job.client_ref }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    // timeout or network error: Pigeon may or may not have it. Retrying with
    // the same Idempotency-Key is safe either way.
    return release(job, { attempts: job.attempts + 1, nextAttemptAt: new Date(Date.now() + backoff(job.attempts)) });
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return release(job, { dispatched: true, pigeonId: body.id, attempts: job.attempts + 1 });
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    const ms = (Number.isFinite(ra) && ra > 0 ? ra : 1) * 1000 + 100;
    await coolOff(job.workspace, ms);
    return release(job, { nextAttemptAt: new Date(Date.now() + ms) });
  }
  if (res.status >= 500) {
    // 503 or outage: back off this workspace a little so we do not hammer it
    await coolOff(job.workspace, 1000);
    return release(job, { attempts: job.attempts + 1, nextAttemptAt: new Date(Date.now() + backoff(job.attempts)) });
  }
  // other 4xx: will never succeed
  console.error('pigeon rejected send', job._id, res.status, await res.text().catch(() => ''));
  await release(job, { dispatched: true, status: 'failed', rank: 2 });
  await emit(job.workspace, { type: 'message.status', contact: job.contact, client_ref: job.client_ref, status: 'failed' }).catch(() => {});
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    while (inflight < MAX_INFLIGHT) {
      const job = await lease();
      if (!job) break;
      inflight++;
      process1(job)
        .catch((e) => console.error('send failed', e))
        .finally(() => {
          inflight--;
          kick();
        });
    }
  } catch (e) {
    console.error('outbox tick failed', e);
  } finally {
    ticking = false;
  }
}

let kickTimer: NodeJS.Timeout | undefined;
export function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = undefined;
    void tick();
  }, 10);
}

export function startOutboxWorker() {
  setInterval(() => void tick(), 250).unref();
  kick();
}
