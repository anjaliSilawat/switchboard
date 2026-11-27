// Realtime frames.
// emit(): seq = Redis INCR per workspace, frame stored in Mongo (for replay),
// then a Redis PUBLISH tells every copy "workspace X has new frames".
// Each socket then pulls frames with seq > last from Mongo, in order. Pulling
// (instead of pushing the published payload) means a socket never skips or
// reorders: a gap (seq taken but not yet stored) is waited out briefly.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { col } from './store.js';
import { getRedis } from './redis.js';
import { config } from './config.js';
import { sessionFromCookie } from './auth.js';

const CHANNEL = 'frames';
const GAP_WAIT_MS = 2000;

export async function emit(workspace: string, frame: Record<string, unknown>) {
  const redis = getRedis();
  const seq = await redis.incr(`seq:${workspace}`);
  await (await col.frames()).insertOne({ workspace, seq, ...frame, at: new Date() });
  await redis.publish(CHANNEL, workspace);
  return seq;
}

interface Client {
  socket: WebSocket;
  workspace: string;
  last: number;
  pulling: boolean;
  again: boolean;
  gapSince?: number;
  timer?: NodeJS.Timeout;
}
const clients = new Set<Client>();

async function pull(c: Client) {
  if (c.pulling) {
    c.again = true;
    return;
  }
  c.pulling = true;
  try {
    do {
      c.again = false;
      const frames = await (await col.frames())
        .find({ workspace: c.workspace, seq: { $gt: c.last } }, { projection: { _id: 0, at: 0 } })
        .sort({ seq: 1 })
        .limit(500)
        .toArray();
      for (const f of frames) {
        if (f.seq !== c.last + 1) {
          // a frame is missing: wait for it a little, then skip it
          c.gapSince ??= Date.now();
          if (Date.now() - c.gapSince < GAP_WAIT_MS) {
            clearTimeout(c.timer);
            c.timer = setTimeout(() => void pull(c), 250);
            break;
          }
        }
        c.gapSince = undefined;
        if (c.socket.readyState !== c.socket.OPEN) return;
        const { workspace: _w, ...out } = f;
        c.socket.send(JSON.stringify(out));
        c.last = f.seq;
      }
    } while (c.again);
  } catch (e) {
    console.error('ws pull failed', e);
  } finally {
    c.pulling = false;
  }
}

export function startRealtime(server: import('node:http').Server) {
  const wss = new WebSocketServer({ noServer: true });
  const sub = getRedis().duplicate();
  void sub.subscribe(CHANNEL);
  sub.on('message', (_ch, workspace) => {
    for (const c of clients) if (c.workspace === workspace) void pull(c);
  });
  // safety net if a publish is missed (Redis blip)
  setInterval(() => {
    for (const c of clients) void pull(c);
  }, 3000).unref();

  server.on('upgrade', async (req: IncomingMessage, sock: Duplex, head: Buffer) => {
    const refuse = (code: number, text: string) => {
      sock.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      sock.destroy();
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws') return refuse(404, 'Not Found');
      const session = await sessionFromCookie(req.headers.cookie);
      if (!session) return refuse(401, 'Unauthorized');
      const workspace = url.searchParams.get('workspace') ?? '';
      if (!session.workspaces.some((w) => w.id === workspace)) return refuse(403, 'Forbidden');
      const afterRaw = url.searchParams.get('after');
      // no `after`: start from "now"; with `after`: replay everything later
      const last =
        afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : Number((await getRedis().get(`seq:${workspace}`)) ?? 0);
      wss.handleUpgrade(req, sock, head, (socket) => {
        const c: Client = { socket, workspace, last, pulling: false, again: false };
        clients.add(c);
        socket.on('close', () => {
          clients.delete(c);
          clearTimeout(c.timer);
        });
        socket.send(JSON.stringify({ type: 'hello', workspace, after: last }));
        void pull(c);
      });
    } catch (e) {
      console.error('upgrade failed', e);
      refuse(500, 'Internal Server Error');
    }
  });
}
