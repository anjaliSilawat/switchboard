import { useCallback, useEffect, useRef, useState } from 'react';

type Role = 'admin' | 'agent';
interface Me { sub: string; name?: string; workspaces: { id: string; role: Role }[] }
interface Conv { contact: string; assignee: string | null; state: 'open' | 'closed'; lastActivityAt: string }
interface Msg { dir: 'in' | 'out'; id: string; text: string; at: string; status?: string; author?: string | null }
interface Frame { seq?: number; type: string; contact?: string; client_ref?: string; status?: string; assignee?: string | null }

const api = async <T,>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const res = await fetch(path, { credentials: 'include', headers: { 'content-type': 'application/json' }, ...init });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [ws, setWs] = useState<string>('');

  useEffect(() => {
    api<Me>('/api/me').then((r) => {
      setMe(r.status === 200 ? r.body : null);
      if (r.status === 200 && r.body.workspaces[0]) setWs(r.body.workspaces[0].id);
    }).catch(() => setMe(null));
  }, []);

  if (me === undefined) return <p style={S.center}>Loading…</p>;
  if (me === null)
    return (
      <main style={S.center}>
        <h1>Switchboard</h1>
        <p>Shared inbox for your support team.</p>
        <a href="/auth/login" style={S.btnPrimary}>Sign in</a>
      </main>
    );

  return (
    <div style={S.app}>
      <header style={S.header}>
        <strong>Switchboard</strong>
        <select value={ws} onChange={(e) => setWs(e.target.value)} style={{ marginLeft: 16 }}>
          {me.workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.id} ({w.role})</option>
          ))}
        </select>
        <span style={{ marginLeft: 'auto' }}>{me.name ?? me.sub}</span>
        <button style={{ marginLeft: 12 }} onClick={() => api('/auth/logout', { method: 'POST' }).then(() => setMe(null))}>Sign out</button>
      </header>
      {ws ? <Inbox key={ws} workspace={ws} me={me} /> : <p style={S.center}>You are not a member of any workspace.</p>}
    </div>
  );
}

// Live connection: reconnects with ?after=<last seq> so nothing is missed.
function useFrames(workspace: string, onFrame: (f: Frame) => void) {
  const [online, setOnline] = useState(false);
  const cb = useRef(onFrame);
  cb.current = onFrame;
  useEffect(() => {
    let last: number | undefined;
    let sock: WebSocket | undefined;
    let stop = false;
    let delay = 500;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      sock = new WebSocket(`${proto}://${location.host}/ws?workspace=${encodeURIComponent(workspace)}${last !== undefined ? `&after=${last}` : ''}`);
      sock.onopen = () => { setOnline(true); delay = 500; };
      sock.onmessage = (m) => {
        const f = JSON.parse(m.data) as Frame & { after?: number };
        if (f.type === 'hello') { if (last === undefined) last = f.after; return; }
        if (typeof f.seq === 'number') { if (last !== undefined && f.seq <= last) return; last = f.seq; }
        cb.current(f);
      };
      sock.onclose = () => {
        setOnline(false);
        if (!stop) setTimeout(connect, (delay = Math.min(delay * 2, 8000)));
      };
    };
    connect();
    return () => { stop = true; sock?.close(); };
  }, [workspace]);
  return online;
}

function Inbox({ workspace, me }: { workspace: string; me: Me }) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [filter, setFilter] = useState<'open' | 'closed' | ''>('open');
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // bump to reload thread

  const loadList = useCallback(async () => {
    const r = await api<{ conversations: Conv[]; next: string | null }>(`/api/conversations?workspace=${workspace}&state=${filter}`);
    if (r.status === 200) { setConvs(r.body.conversations); setNext(r.body.next); }
  }, [workspace, filter]);
  useEffect(() => { void loadList(); }, [loadList]);

  const more = async () => {
    if (!next) return;
    const r = await api<{ conversations: Conv[]; next: string | null }>(`/api/conversations?workspace=${workspace}&state=${filter}&cursor=${encodeURIComponent(next)}`);
    if (r.status === 200) { setConvs((c) => [...c, ...r.body.conversations]); setNext(r.body.next); }
  };

  const reloadTimer = useRef<number | undefined>(undefined);
  const online = useFrames(workspace, (f) => {
    // keep it simple: refresh the list (debounced) and the open thread
    clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => void loadList(), 300);
    if (f.contact && f.contact === open) setTick((t) => t + 1);
  });

  return (
    <div style={S.body}>
      <aside style={S.list}>
        <div style={S.listHead}>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="">All</option>
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: online ? 'green' : 'crimson' }}>{online ? '● live' : '● reconnecting'}</span>
        </div>
        {convs.length === 0 && <p style={{ padding: 12, color: '#666' }}>No conversations yet.</p>}
        {convs.map((c) => (
          <button key={c.contact} onClick={() => setOpen(c.contact)} style={{ ...S.row, background: c.contact === open ? '#eef3ff' : 'white' }}>
            <div style={{ fontWeight: 600 }}>{c.contact}</div>
            <div style={{ fontSize: 12, color: '#666' }}>
              {new Date(c.lastActivityAt).toLocaleTimeString()} · {c.assignee ? (c.assignee === me.sub ? 'you' : c.assignee) : 'unassigned'}{c.state === 'closed' ? ' · closed' : ''}
            </div>
          </button>
        ))}
        {next && <button style={S.more} onClick={more}>Load more</button>}
      </aside>
      <section style={S.thread}>
        {open ? <Thread workspace={workspace} contact={open} me={me} tick={tick} onChange={loadList} /> : <p style={S.center}>Pick a conversation.</p>}
      </section>
    </div>
  );
}

function Thread({ workspace, contact, me, tick, onChange }: { workspace: string; contact: string; me: Me; tick: number; onChange: () => void }) {
  const [data, setData] = useState<{ conversation: { assignee: string | null; state: string } | null; messages: Msg[] } | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const base = `/api/conversations/${encodeURIComponent(contact)}`;
  const q = `?workspace=${encodeURIComponent(workspace)}`;
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await api<typeof data>(base + q);
    if (r.status === 200) setData(r.body);
  }, [base, q]);
  useEffect(() => { void load(); }, [load, tick]);
  useEffect(() => { endRef.current?.scrollIntoView(); }, [data?.messages.length]);

  const act = async (what: 'claim' | 'release' | 'close' | 'reopen') => {
    const r = await api(`${base}/${what}${q}`, { method: 'POST' });
    setErr(r.status === 409 ? 'Someone else already holds this conversation.' : '');
    await load();
    onChange();
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    // one client_ref per reply: a retried POST is the same reply, never two
    const client_ref = crypto.randomUUID();
    setText('');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await api(`${base}/reply${q}`, { method: 'POST', body: JSON.stringify({ text: body, client_ref }) });
        if (r.status === 202) { setErr(''); await load(); return; }
        if (r.status < 500) { setErr('Reply rejected'); return; }
      } catch { /* network: retry with the same client_ref */ }
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
    }
    setErr('Could not send. Your text is back in the box.');
    setText(body);
  };

  const c = data?.conversation;
  const mine = c?.assignee === me.sub;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={S.threadHead}>
        <strong>{contact}</strong>
        <span style={{ marginLeft: 12, color: '#666' }}>{c?.assignee ? `held by ${mine ? 'you' : c.assignee}` : 'unassigned'} · {c?.state ?? 'open'}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {!mine && <button onClick={() => act('claim')} disabled={!!c?.assignee}>Claim</button>}
          {mine && <button onClick={() => act('release')}>Release</button>}
          {c?.state === 'closed' ? <button onClick={() => act('reopen')}>Reopen</button> : <button onClick={() => act('close')}>Close</button>}
        </span>
      </div>
      <div style={S.msgs}>
        {data?.messages.map((m) => (
          <div key={m.dir + m.id} style={{ display: 'flex', justifyContent: m.dir === 'in' ? 'flex-start' : 'flex-end' }}>
            <div style={{ ...S.bubble, background: m.dir === 'in' ? '#f1f1f1' : '#dbe7ff' }}>
              <div>{m.text}</div>
              <div style={{ fontSize: 11, color: m.status === 'failed' ? 'crimson' : '#666', marginTop: 4 }}>
                {new Date(m.at).toLocaleTimeString()}{m.dir === 'out' ? ` · ${m.status}` : ''}
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {err && <div style={{ color: 'crimson', padding: '4px 12px' }}>{err}</div>}
      <form style={S.compose} onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply…" style={{ flex: 1, padding: 8 }} />
        <button type="submit" style={S.btnPrimary}>Send</button>
      </form>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  center: { font: '16px system-ui', textAlign: 'center', marginTop: 80 },
  app: { font: '14px system-ui', height: '100vh', display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #ddd' },
  body: { flex: 1, display: 'flex', minHeight: 0 },
  list: { width: 300, borderRight: '1px solid #ddd', overflowY: 'auto' },
  listHead: { display: 'flex', padding: 8, borderBottom: '1px solid #eee', alignItems: 'center' },
  row: { display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 0, borderBottom: '1px solid #eee', cursor: 'pointer' },
  more: { width: '100%', padding: 10 },
  thread: { flex: 1, minWidth: 0 },
  threadHead: { display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid #ddd' },
  msgs: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 6 },
  bubble: { maxWidth: '70%', padding: '8px 10px', borderRadius: 8 },
  compose: { display: 'flex', gap: 8, padding: 12, borderTop: '1px solid #ddd' },
  btnPrimary: { background: '#2952e3', color: 'white', border: 0, padding: '8px 14px', borderRadius: 6, textDecoration: 'none', cursor: 'pointer' },
};
