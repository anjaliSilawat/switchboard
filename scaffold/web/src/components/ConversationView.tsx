import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Me, type Message } from '../api';
import { NotesPanel } from './NotesPanel';
import { avatarColor, initials } from '../avatar';

interface ThreadResponse {
  conversation: { assignee: string | null; assigneeName: string | null; state: 'open' | 'closed' } | null;
  messages: Message[];
}

interface Props {
  workspace: string;
  contact: string;
  me: Me;
  refreshKey: number;
  onChanged: () => void;
}

export function ConversationView({ workspace, contact, me, refreshKey, onChanged }: Props) {
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const base = `/api/conversations/${encodeURIComponent(contact)}`;
  const query = `?workspace=${encodeURIComponent(workspace)}`;

  const load = useCallback(async () => {
    const res = await api<ThreadResponse>(base + query);
    if (res.status === 200) setThread(res.body);
  }, [base, query]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // scroll to the newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread?.messages.length]);

  async function doAction(action: 'claim' | 'release' | 'close' | 'reopen') {
    const res = await api(`${base}/${action}${query}`, { method: 'POST' });
    setError(res.status === 409 ? 'Another agent already holds this conversation.' : '');
    await load();
    onChanged();
  }

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;

    // One id per reply. If the request fails and we try again with the SAME
    // id, the server knows it is the same reply and does not send it twice.
    const clientRef = crypto.randomUUID();
    setText('');
    setSending(true);

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await api(`${base}/reply${query}`, { method: 'POST', body: JSON.stringify({ text: body, client_ref: clientRef }) });
        if (res.status === 202) {
          setError('');
          setSending(false);
          await load();
          return;
        }
        if (res.status < 500) break; // our mistake, retrying will not help
      } catch {
        // network error: try again
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }

    setSending(false);
    setError('Could not send the reply. Your text is back in the box.');
    setText(body);
  }

  const conversation = thread?.conversation;
  const heldByMe = conversation?.assignee === me.sub;
  const holderName = heldByMe ? 'you' : conversation?.assigneeName ?? conversation?.assignee;

  return (
    <div className="conversation">
      <div className="conversation-main">
        <div className="conversation-head">
          <span className="avatar" style={{ background: avatarColor(contact) }}>
            {initials(contact)}
          </span>
          <div>
            <div className="contact">{contact}</div>
            <div className="muted small">
              {conversation?.assignee ? `Assigned to ${holderName}` : 'Nobody is handling this yet'} · {conversation?.state ?? 'open'}
            </div>
          </div>

          <div className="actions">
            {!heldByMe && (
              <button className="btn primary" onClick={() => doAction('claim')} disabled={!!conversation?.assignee}>
                Claim
              </button>
            )}
            {heldByMe && (
              <button className="btn ghost" onClick={() => doAction('release')}>
                Release
              </button>
            )}
            {conversation?.state === 'closed' ? (
              <button className="btn ghost" onClick={() => doAction('reopen')}>
                Reopen
              </button>
            ) : (
              <button className="btn ghost" onClick={() => doAction('close')}>
                Close
              </button>
            )}
          </div>
        </div>

        <div className="messages">
          {thread?.messages.map((m, i) => {
            // show a small date label when the day changes
            const day = new Date(m.at).toDateString();
            const newDay = i === 0 || day !== new Date(thread.messages[i - 1].at).toDateString();
            return (
              <div key={m.dir + m.id} style={{ display: 'contents' }}>
                {newDay && <div className="day">{day === new Date().toDateString() ? 'Today' : day}</div>}
                <div className={m.dir === 'in' ? 'bubble-row in' : 'bubble-row out'}>
                  <div className="bubble">
                    <div>{m.text}</div>
                    <div className="bubble-meta">
                      {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      {m.dir === 'out' && <span className={`status ${m.status}`}>{m.status}</span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {error && <div className="error">{error}</div>}

        <form className="composer" onSubmit={sendReply}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply to ${contact}…`} />
          <button className="btn primary" type="submit" disabled={sending || !text.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      </div>

      <NotesPanel workspace={workspace} contact={contact} refreshKey={refreshKey} />
    </div>
  );
}
