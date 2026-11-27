// Inbox services shared by the UI API and the grader endpoints.
import { col, isDupKey, type Conversation } from './store.js';
import { emit } from './realtime.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { ensureIndexes } from './store.js';

// Claim is one atomic conditional upsert: it matches only if the conversation
// is free or already ours. If someone else holds it the filter does not match,
// the upsert tries to insert the same _id and fails with E11000 -> 409.
export async function claim(workspace: string, contact: string, agent: string): Promise<boolean> {
  const c = await col.conversations();
  const _id = `${workspace}:${contact}`;
  let before: Conversation | null;
  try {
    before = await c.findOneAndUpdate(
      { _id, $or: [{ assignee: null }, { assignee: agent }] },
      { $set: { assignee: agent }, $setOnInsert: { workspace, contact, state: 'open', lastActivityAt: new Date() } },
      { upsert: true, returnDocument: 'before' },
    );
  } catch (e) {
    if (!isDupKey(e)) throw e;
    const now = await c.findOne({ _id });
    return now?.assignee === agent;
  }
  if (before?.assignee !== agent) await emit(workspace, { type: 'conversation.assigned', contact, assignee: agent });
  return true;
}

export async function release(workspace: string, contact: string, agent: string) {
  const r = await (await col.conversations()).updateOne({ _id: `${workspace}:${contact}`, assignee: agent }, { $set: { assignee: null } });
  if (r.modifiedCount) await emit(workspace, { type: 'conversation.assigned', contact, assignee: null });
  return r.modifiedCount > 0;
}

export async function setState(workspace: string, contact: string, state: 'open' | 'closed') {
  const r = await (await col.conversations()).updateOne({ _id: `${workspace}:${contact}` }, { $set: { state } });
  if (r.modifiedCount) await emit(workspace, { type: 'conversation.state', contact, state });
  return r.matchedCount > 0;
}

// Newest activity first, keyset pagination: cursor = "<ms>|<_id>" of the last row.
export async function listConversations(workspace: string, limit = 30, cursor?: string, state?: string) {
  const filter: Record<string, unknown> = { workspace };
  if (state === 'open' || state === 'closed') filter.state = state;
  if (cursor) {
    const [ms, id] = cursor.split('|');
    const at = new Date(Number(ms));
    filter.$or = [{ lastActivityAt: { $lt: at } }, { lastActivityAt: at, _id: { $lt: id } }];
  }
  const rows = await (await col.conversations()).find(filter).sort({ lastActivityAt: -1, _id: -1 }).limit(limit).toArray();
  const last = rows[rows.length - 1];
  return {
    conversations: rows.map(({ _id, ...r }) => r),
    next: rows.length === limit && last ? `${last.lastActivityAt.getTime()}|${last._id}` : null,
  };
}

// Messages of one conversation, oldest first. Inbound by occurred_at, our
// replies by the time the agent sent them.
export async function thread(workspace: string, contact: string) {
  const [ins, outs, conv] = await Promise.all([
    (await col.inbound()).find({ workspace, contact }).sort({ occurred_at: 1, message_id: 1 }).toArray(),
    (await col.outbound()).find({ workspace, contact }).sort({ createdAt: 1 }).toArray(),
    (await col.conversations()).findOne({ _id: `${workspace}:${contact}` }),
  ]);
  const messages = [
    ...ins.map((m) => ({ dir: 'in' as const, id: m.message_id, text: m.text, at: m.occurred_at })),
    ...outs.map((m) => ({ dir: 'out' as const, id: m.client_ref, text: m.text, at: m.createdAt, status: m.status, author: m.author })),
  ].sort((a, b) => +a.at - +b.at);
  return { conversation: conv && { contact: conv.contact, assignee: conv.assignee, state: conv.state }, messages };
}

export async function snapshot() {
  const workspaces: Record<string, { contacts: Record<string, { inbound: string[]; assignee: string | null }>; outbound: Record<string, string> }> = {};
  const ws = (id: string) => (workspaces[id] ??= { contacts: {}, outbound: {} });
  const contact = (w: string, c: string) => (ws(w).contacts[c] ??= { inbound: [], assignee: null });
  for (const conv of await (await col.conversations()).find().toArray()) contact(conv.workspace, conv.contact).assignee = conv.assignee ?? null;
  const ins = (await col.inbound()).find({}, { projection: { workspace: 1, contact: 1, message_id: 1 } }).sort({ workspace: 1, contact: 1, occurred_at: 1, message_id: 1 });
  for await (const m of ins) contact(m.workspace, m.contact).inbound.push(m.message_id);
  for await (const m of (await col.outbound()).find({}, { projection: { workspace: 1, client_ref: 1, status: 1 } })) ws(m.workspace).outbound[m.client_ref] = m.status;
  return { workspaces };
}

// Delete application data (Mongo + Redis). Login sessions (sess:*) stay.
export async function resetAll() {
  const db = await getDb();
  for (const name of ['inbound', 'outbound', 'conversations', 'frames', 'notes']) await db.collection(name).deleteMany({});
  const redis = getRedis();
  for (const pattern of ['seq:*', 'bucket:*', 'cool:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  }
  await ensureIndexes();
}
