import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { ensureIndexes } from './store.js';
import { pigeonWebhook } from './webhook.js';
import { enqueueReply, startOutboxWorker, UnknownWorkspace } from './outbox.js';
import { addNote, claim, listConversations, listNotes, release, resetAll, setState, snapshot, thread } from './inbox.js';
import { callback, login, logout, requireMember, requireSession } from './auth.js';
import { startRealtime } from './realtime.js';

const app = express();
app.disable('x-powered-by');
let ready = false;

app.get('/healthz', (_req, res) => {
  res.status(ready ? 200 : 503).json({ ok: ready });
});

// Webhook needs the raw bytes for the signature, so it is registered before
// the JSON parser.
app.post('/webhooks/pigeon', express.raw({ type: () => true, limit: '1mb' }), pigeonWebhook);

app.use(express.json({ limit: '100kb' }));

const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res, next).catch(next);

// ---------------- grader endpoints (same services as the UI) ----------------
const grader = express.Router();
grader.use((req, res, next) => {
  const got = Buffer.from(String(req.header('x-grader-token') ?? ''));
  const want = Buffer.from(config.graderToken);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: 'bad grader token' });
  next();
});
grader.post('/reset', wrap(async (_req, res) => {
  await resetAll();
  res.status(200).json({ ok: true });
}));
grader.get('/snapshot', wrap(async (_req, res) => {
  res.json(await snapshot());
}));
grader.post('/reply', wrap(async (req, res) => {
  const { workspace, contact, text, client_ref } = req.body ?? {};
  if (![workspace, contact, text, client_ref].every((v) => typeof v === 'string' && v)) return res.status(400).json({ error: 'bad body' });
  try {
    await enqueueReply(workspace, contact, text, client_ref, null);
  } catch (e) {
    if (e instanceof UnknownWorkspace) return res.status(404).json({ error: 'unknown workspace' });
    throw e;
  }
  res.status(202).json({ ok: true });
}));
grader.post('/claim', wrap(async (req, res) => {
  const { workspace, contact, agent } = req.body ?? {};
  if (![workspace, contact, agent].every((v) => typeof v === 'string' && v)) return res.status(400).json({ error: 'bad body' });
  if (!(workspace in config.pigeon.apiKeys)) return res.status(404).json({ error: 'unknown workspace' });
  res.status((await claim(workspace, contact, agent)) ? 200 : 409).json({});
}));
app.use('/__grader', grader);

// ---------------- auth ----------------
app.get('/auth/login', wrap(login));
app.get('/auth/callback', wrap(callback));
app.post('/auth/logout', wrap(logout));

// ---------------- API for the React app ----------------
const api = express.Router();
api.use(wrap(requireSession));
api.get('/me', (req, res) => {
  const s = req.session!;
  res.json({ sub: s.sub, name: s.name, email: s.email, workspaces: s.workspaces });
});
api.get('/conversations', requireMember, wrap(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  res.json(await listConversations(String(req.query.workspace), limit, req.query.cursor ? String(req.query.cursor) : undefined, req.query.state ? String(req.query.state) : undefined));
}));
api.get('/conversations/:contact', requireMember, wrap(async (req, res) => {
  res.json(await thread(String(req.query.workspace), req.params.contact));
}));
api.post('/conversations/:contact/reply', requireMember, wrap(async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text || text.length > 4000) return res.status(400).json({ error: 'text required (max 4000)' });
  // the browser generates client_ref so a retried POST is the same reply
  const ref = typeof req.body?.client_ref === 'string' && /^[\w-]{8,64}$/.test(req.body.client_ref) ? req.body.client_ref : randomUUID();
  await enqueueReply(String(req.query.workspace), req.params.contact, text, ref, req.session!.sub);
  res.status(202).json({ client_ref: ref });
}));
api.post('/conversations/:contact/claim', requireMember, wrap(async (req, res) => {
  const ok = await claim(String(req.query.workspace), req.params.contact, req.session!.sub, req.session!.name ?? null);
  res.status(ok ? 200 : 409).json({ ok });
}));
api.post('/conversations/:contact/release', requireMember, wrap(async (req, res) => {
  res.json({ ok: await release(String(req.query.workspace), req.params.contact, req.session!.sub) });
}));
api.post('/conversations/:contact/close', requireMember, wrap(async (req, res) => {
  res.status((await setState(String(req.query.workspace), req.params.contact, 'closed')) ? 200 : 404).json({});
}));
api.post('/conversations/:contact/reopen', requireMember, wrap(async (req, res) => {
  res.status((await setState(String(req.query.workspace), req.params.contact, 'open')) ? 200 : 404).json({});
}));
// Private notes: the body is already encrypted by the browser.
api.get('/conversations/:contact/notes', requireMember, wrap(async (req, res) => {
  res.json({ notes: await listNotes(String(req.query.workspace), req.params.contact) });
}));
api.post('/conversations/:contact/notes', requireMember, wrap(async (req, res) => {
  const { ciphertext, iv } = req.body ?? {};
  const isBase64 = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9+/=]+$/.test(v);
  if (!isBase64(ciphertext, 20000) || !isBase64(iv, 32)) return res.status(400).json({ error: 'ciphertext and iv (base64) required' });
  await addNote(String(req.query.workspace), req.params.contact, req.session!.sub, req.session!.name ?? null, ciphertext, iv);
  res.status(201).json({ ok: true });
}));
app.use('/api', api);

// The built React app (npm run web:build) is served from this server, so
// http://localhost:<PORT> is the whole product on one origin.
const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
if (existsSync(webDist)) {
  app.use(express.static(webDist, { index: 'index.html' }));
  app.get(/^\/(?!api|auth|ws|__grader|webhooks|healthz).*/, (_req, res) => res.sendFile('index.html', { root: webDist }));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

const server = createServer(app);
startRealtime(server);

async function boot() {
  for (;;) {
    try {
      await getDb();
      await getRedis().ping();
      await ensureIndexes();
      break;
    } catch (e) {
      console.error('waiting for MongoDB/Redis', (e as Error).message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  startOutboxWorker();
  ready = true;
}

server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
  void boot();
});
