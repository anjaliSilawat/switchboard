// POST /webhooks/pigeon
// Order matters: verify signature on the RAW body -> check timestamp -> parse
// -> store idempotently -> only then answer 2xx. If we crash before the write,
// Pigeon gets no 2xx and retries, so nothing is lost.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { col, isDupKey, touchConversation, STATUS_RANK, type Status } from './store.js';
import { emit } from './realtime.js';

const MAX_AGE_S = 5 * 60;

export function verifySignature(header: string | undefined, raw: Buffer, secret: string, nowS = Date.now() / 1000) {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(nowS - Number(t)) > MAX_AGE_S) return false; // stale / replayed
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]+$/i.test(s)) return false;
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export async function pigeonWebhook(req: Request, res: Response) {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifySignature(req.header('x-pigeon-signature'), raw, config.pigeon.webhookSecret)) {
    return res.status(401).json({ error: 'bad signature' });
  }
  let evt: any;
  try {
    evt = JSON.parse(raw.toString('utf8'));
    if (!evt || typeof evt !== 'object') throw new Error('not an object');
  } catch {
    return res.status(400).json({ error: 'unparseable body' });
  }
  const workspace = evt.workspace;
  if (typeof workspace !== 'string' || !(workspace in config.pigeon.apiKeys)) return res.status(200).json({ ignored: 'workspace' });

  try {
    if (evt.type === 'message.inbound') {
      const d = evt.data ?? {};
      if (typeof d.message_id !== 'string' || typeof d.from !== 'string') return res.status(400).json({ error: 'bad data' });
      const occurred = new Date(evt.occurred_at);
      await storeInbound(workspace, d.message_id, d.from, String(d.text ?? ''), isNaN(+occurred) ? new Date() : occurred);
    } else if (evt.type === 'message.status') {
      const d = evt.data ?? {};
      // a status we do not know (Pigeon may add some) is acknowledged and ignored
      if (typeof d.client_ref !== 'string' || !Object.hasOwn(STATUS_RANK, d.status)) return res.status(200).json({ ignored: 'status' });
      await applyStatus(workspace, d.client_ref, d.status as Status, d.message_id);
    }
    // unknown type: acknowledge and ignore
    return res.status(200).json({ ok: true });
  } catch (e) {
    // storage failed: not stored, so let Pigeon retry
    console.error('webhook store failed', e);
    return res.status(503).json({ error: 'try again' });
  }
}

export async function storeInbound(workspace: string, messageId: string, contact: string, text: string, occurred: Date) {
  const inbound = await col.inbound();
  const _id = `${workspace}:${messageId}`;
  let fresh = true;
  try {
    await inbound.insertOne({ _id, workspace, contact, message_id: messageId, text, occurred_at: occurred, framed: false });
  } catch (e) {
    if (!isDupKey(e)) throw e;
    fresh = false;
  }
  if (fresh) await touchConversation(workspace, contact, occurred, true);
  // a crash between insert and emit leaves framed=false; the retry emits it
  const doc = fresh ? null : await inbound.findOne({ _id }, { projection: { framed: 1 } });
  if (fresh || doc?.framed === false) {
    if (!fresh) await touchConversation(workspace, contact, occurred, true);
    await emit(workspace, { type: 'message.inbound', contact, message_id: messageId, text, occurred_at: occurred });
    await inbound.updateOne({ _id }, { $set: { framed: true } });
  }
}

export async function applyStatus(workspace: string, clientRef: string, status: Status, pigeonId?: string) {
  const out = await col.outbound();
  // only move forward: delivered arriving before sent must not be overwritten
  const r = await out.findOneAndUpdate(
    { _id: `${workspace}:${clientRef}`, rank: { $lt: STATUS_RANK[status] } },
    { $set: { status, rank: STATUS_RANK[status], dispatched: true, ...(pigeonId ? { pigeonId } : {}) } },
    { returnDocument: 'after' },
  );
  if (r) await emit(workspace, { type: 'message.status', contact: r.contact, client_ref: clientRef, status });
  // else: unknown client_ref (never sent by us) or stale status: ignore
}
