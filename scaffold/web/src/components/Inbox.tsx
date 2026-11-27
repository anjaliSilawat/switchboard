import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Conversation, type Me } from '../api';
import { useLiveUpdates } from '../useLiveUpdates';
import { ConversationView } from './ConversationView';

type Filter = 'open' | 'closed' | '';

interface ListResponse {
  conversations: Conversation[];
  next: string | null; // cursor for the next page
}

export function Inbox({ workspace, me }: { workspace: string; me: Me }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0); // bump to reload the open conversation

  const loadFirstPage = useCallback(async () => {
    const res = await api<ListResponse>(`/api/conversations?workspace=${workspace}&state=${filter}`);
    if (res.status === 200) {
      setConversations(res.body.conversations);
      setNextCursor(res.body.next);
    }
  }, [workspace, filter]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  async function loadMore() {
    if (!nextCursor) return;
    const res = await api<ListResponse>(`/api/conversations?workspace=${workspace}&state=${filter}&cursor=${encodeURIComponent(nextCursor)}`);
    if (res.status === 200) {
      setConversations((old) => [...old, ...res.body.conversations]);
      setNextCursor(res.body.next);
    }
  }

  // Something changed on the server: reload the list (at most every 300 ms)
  // and the open conversation if the change is about it.
  const reloadTimer = useRef<number | undefined>(undefined);
  const online = useLiveUpdates(workspace, (frame) => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(loadFirstPage, 300);
    if (frame.contact && frame.contact === selected) setRefreshKey((k) => k + 1);
  });

  return (
    <div className="inbox">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="tabs">
            {(['open', 'closed', ''] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? 'tab active' : 'tab'} onClick={() => setFilter(f)}>
                {f === '' ? 'All' : f === 'open' ? 'Open' : 'Closed'}
              </button>
            ))}
          </div>
          <span className={online ? 'live on' : 'live off'}>{online ? 'Live' : 'Reconnecting…'}</span>
        </div>

        <div className="conversation-list">
          {conversations.length === 0 && <p className="empty small">No conversations here yet.</p>}

          {conversations.map((c) => (
            <button key={c.contact} className={c.contact === selected ? 'conversation-row selected' : 'conversation-row'} onClick={() => setSelected(c.contact)}>
              <span className="avatar">{c.contact.slice(-2)}</span>
              <span className="row-main">
                <span className="row-top">
                  <strong>{c.contact}</strong>
                  <span className="time">{formatTime(c.lastActivityAt)}</span>
                </span>
                <span className="row-bottom">
                  {c.assignee ? (
                    <span className={c.assignee === me.sub ? 'pill mine' : 'pill taken'}>
                      {c.assignee === me.sub ? 'You' : c.assigneeName ?? c.assignee}
                    </span>
                  ) : (
                    <span className="pill free">Unassigned</span>
                  )}
                  {c.state === 'closed' && <span className="pill closed">Closed</span>}
                </span>
              </span>
            </button>
          ))}

          {nextCursor && (
            <button className="btn ghost wide" onClick={loadMore}>
              Load more
            </button>
          )}
        </div>
      </aside>

      <main className="main">
        {selected ? (
          <ConversationView workspace={workspace} contact={selected} me={me} refreshKey={refreshKey} onChanged={loadFirstPage} />
        ) : (
          <div className="empty">
            <div className="empty-icon">💬</div>
            <h3>Pick a conversation</h3>
            <p className="muted">New customer messages show up on the left as they arrive.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

