// Collections and indexes. Ids are deterministic ("<workspace>:<natural key>")
// so every write is idempotent: a duplicate insert fails with E11000 instead
// of creating a second row. That is the core of "at least once" safety.
import type { Collection, Document } from 'mongodb';
import { getDb } from './db.js';

export type Status = 'queued' | 'sent' | 'delivered' | 'failed';
// Status only moves forward. delivered/failed are both final (same rank).
export const STATUS_RANK: Record<Status, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };

export interface InboundMsg {
  _id: string; // ws:message_id
  workspace: string;
  contact: string;
  message_id: string;
  text: string;
  occurred_at: Date;
  framed?: boolean; // a realtime frame was emitted for it
}

export interface OutboundMsg {
  _id: string; // ws:client_ref
  workspace: string;
  contact: string;
  client_ref: string;
  text: string;
  author: string | null;
  status: Status;
  rank: number;
  createdAt: Date;
  dispatched: boolean; // Pigeon accepted it; the worker never sends it again
  pigeonId?: string;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date; // lease: a worker owns the job until then
  lockedBy?: string;
}

export interface Conversation {
  _id: string; // ws:contact
  workspace: string;
  contact: string;
  assignee: string | null;
  state: 'open' | 'closed';
  lastActivityAt: Date;
}

export interface Frame {
  workspace: string;
  seq: number;
  [k: string]: unknown;
}

export const col = {
  inbound: async () => (await getDb()).collection<InboundMsg>('inbound'),
  outbound: async () => (await getDb()).collection<OutboundMsg>('outbound'),
  conversations: async () => (await getDb()).collection<Conversation>('conversations'),
  frames: async () => (await getDb()).collection<Frame>('frames'),
  notes: async () => (await getDb()).collection<Document>('notes'),
};

export async function ensureIndexes() {
  await (await col.inbound()).createIndex({ workspace: 1, contact: 1, occurred_at: 1, message_id: 1 });
  await (await col.outbound()).createIndex({ dispatched: 1, nextAttemptAt: 1, lockedUntil: 1 });
  await (await col.outbound()).createIndex({ workspace: 1, contact: 1, createdAt: 1 });
  await (await col.conversations()).createIndex({ workspace: 1, lastActivityAt: -1, _id: -1 });
  await (await col.frames()).createIndex({ workspace: 1, seq: 1 }, { unique: true });
}

export const isDupKey = (e: unknown) => (e as { code?: number })?.code === 11000;

// Concurrent upserts on the same _id can race to insert; the loser gets
// E11000 and simply retries as an update.
export async function upsertRetry<T extends Document>(c: Collection<T>, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (e) {
    if (!isDupKey(e)) throw e;
    return await fn();
  }
}

export async function touchConversation(workspace: string, contact: string, at: Date, reopen: boolean) {
  const c = await col.conversations();
  await upsertRetry(c, () =>
    c.updateOne(
      { _id: `${workspace}:${contact}` },
      {
        $setOnInsert: { workspace, contact, assignee: null, ...(reopen ? {} : { state: 'open' as const }) },
        $max: { lastActivityAt: at },
        ...(reopen ? { $set: { state: 'open' as const } } : {}),
      },
      { upsert: true },
    ),
  );
}
