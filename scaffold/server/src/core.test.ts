// Run: npm --prefix scaffold/server test   (needs MongoDB + Redis from `npm run up`)
// Uses a separate database so it never touches dev data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.MONGO_URL = 'mongodb://localhost:27017/switchboard_test';
process.env.REDIS_URL = 'redis://localhost:6379/1';

const { verifySignature, applyStatus } = await import('./webhook.js');
const { claim, resetAll, snapshot } = await import('./inbox.js');
const { col } = await import('./store.js');
const { getDb } = await import('./db.js');
const { getRedis } = await import('./redis.js');

const secret = 'whsec_test';
const sign = (body: string, t: number) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('signature: valid, tampered, stale, malformed', () => {
  const now = Math.floor(Date.now() / 1000);
  const body = '{"a":1}';
  assert.equal(verifySignature(sign(body, now), Buffer.from(body), secret), true);
  assert.equal(verifySignature(sign(body, now - 299), Buffer.from(body), secret), true, 'up to five minutes old is genuine');
  assert.equal(verifySignature(sign(body, now), Buffer.from('{"a":2}'), secret), false, 'tampered body');
  assert.equal(verifySignature(sign(body, now - 301), Buffer.from(body), secret), false, 'stale');
  assert.equal(verifySignature(undefined, Buffer.from(body), secret), false);
  assert.equal(verifySignature('garbage', Buffer.from(body), secret), false);
  assert.equal(verifySignature(`t=${now},v1=zz`, Buffer.from(body), secret), false);
});

before(async () => {
  await resetAll();
});
after(async () => {
  await (await getDb()).dropDatabase();
  await getRedis().flushdb();
  process.exit(0); // close Mongo/Redis handles
});

test('claim: six agents at once, exactly one wins; holder may claim again', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => claim('ws_acme', '+1000', `agent_${i}`)));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = `agent_${results.indexOf(true)}`;
  assert.equal(await claim('ws_acme', '+1000', winner), true);
  const snap = await snapshot();
  assert.equal(snap.workspaces.ws_acme.contacts['+1000'].assignee, winner);
});

test('status only moves forward (delivered before sent)', async () => {
  const out = await col.outbound();
  await out.insertOne({
    _id: 'ws_acme:r1', workspace: 'ws_acme', contact: '+1000', client_ref: 'r1', text: 'x', author: null,
    status: 'queued', rank: 0, createdAt: new Date(), dispatched: false, attempts: 0, nextAttemptAt: new Date(), lockedUntil: new Date(0),
  });
  await applyStatus('ws_acme', 'r1', 'delivered');
  await applyStatus('ws_acme', 'r1', 'sent'); // late, must be ignored
  assert.equal((await out.findOne({ _id: 'ws_acme:r1' }))?.status, 'delivered');
  await applyStatus('ws_acme', 'never-sent', 'sent'); // unknown ref: ignored, no throw
});
