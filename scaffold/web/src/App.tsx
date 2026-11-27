import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { LoginPage } from './components/LoginPage';
import { Inbox } from './components/Inbox';

export function App() {
  // undefined = still loading, null = not signed in
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState('');

  useEffect(() => {
    api<Me>('/api/me')
      .then((res) => {
        if (res.status !== 200) return setMe(null);
        setMe(res.body);
        setWorkspace(res.body.workspaces[0]?.id ?? '');
      })
      .catch(() => setMe(null));
  }, []);

  async function signOut() {
    await api('/auth/logout', { method: 'POST' });
    setMe(null);
  }

  if (me === undefined) return <div className="loading">Loading…</div>;
  if (me === null) return <LoginPage />;

  const role = me.workspaces.find((w) => w.id === workspace)?.role;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">S</span>
          <span>Switchboard</span>
        </div>

        <select className="workspace-select" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
          {me.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id}
            </option>
          ))}
        </select>
        {role && <span className={`role-badge ${role}`}>{role}</span>}

        <div className="topbar-right">
          <span className="avatar small">{initials(me.name ?? me.sub)}</span>
          <span className="user-name">{me.name ?? me.sub}</span>
          <button className="btn ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {workspace ? (
        // key={workspace}: switching workspace starts a fresh inbox and socket
        <Inbox key={workspace} workspace={workspace} me={me} />
      ) : (
        <div className="empty">You are not a member of any workspace.</div>
      )}
    </div>
  );
}

export function initials(name: string) {
  const parts = name.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}
