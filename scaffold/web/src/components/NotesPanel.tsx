import { useEffect, useState } from 'react';
import { api, type Note } from '../api';
import { decryptNote, deriveKey, encryptNote } from '../notesCrypto';

// Private notes for teammates. Encrypted in the browser before they are sent,
// decrypted in the browser after they are loaded. The server only sees
// ciphertext. The key lives in memory only, so after a reload the agent types
// the team passphrase again.
const keys = new Map<string, CryptoKey>(); // workspace -> key, for this tab only

export function NotesPanel({ workspace, contact, refreshKey }: { workspace: string; contact: string; refreshKey: number }) {
  const [key, setKey] = useState<CryptoKey | undefined>(keys.get(workspace));
  const [passphrase, setPassphrase] = useState('');
  const [notes, setNotes] = useState<{ note: Note; text: string | null }[]>([]);
  const [draft, setDraft] = useState('');

  const url = `/api/conversations/${encodeURIComponent(contact)}/notes?workspace=${encodeURIComponent(workspace)}`;

  // load and decrypt the notes of this conversation
  useEffect(() => {
    if (!key) return;
    (async () => {
      const res = await api<{ notes: Note[] }>(url);
      if (res.status !== 200) return;
      const decrypted = await Promise.all(res.body.notes.map(async (note) => ({ note, text: await decryptNote(key, note.ciphertext, note.iv) })));
      setNotes(decrypted);
    })();
  }, [key, url, refreshKey]);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (passphrase.length < 8) return;
    const k = await deriveKey(passphrase, workspace);
    keys.set(workspace, k);
    setKey(k);
    setPassphrase('');
  }

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!key || !draft.trim()) return;
    const encrypted = await encryptNote(key, draft.trim());
    const res = await api(url, { method: 'POST', body: JSON.stringify(encrypted) });
    if (res.status === 201) {
      setNotes((old) => [...old, { note: { id: 'new' + Date.now(), authorName: 'You', createdAt: new Date().toISOString(), ...encrypted }, text: draft.trim() }]);
      setDraft('');
    }
  }

  return (
    <aside className="notes">
      <div className="notes-head">
        <span>🔒 Private notes</span>
        <span className="muted small">only your team can read these</span>
      </div>

      {!key ? (
        <form className="unlock" onSubmit={unlock}>
          <p className="muted small">Enter your team passphrase to read and write notes. It never leaves your browser.</p>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Team passphrase (min 8 characters)" />
          <button className="btn primary wide" type="submit" disabled={passphrase.length < 8}>
            Unlock notes
          </button>
        </form>
      ) : (
        <>
          <div className="note-list">
            {notes.length === 0 && <p className="muted small">No notes yet.</p>}
            {notes.map(({ note, text }) => (
              <div key={note.id} className="note">
                {text ?? <em className="muted">Can not decrypt (written with a different passphrase)</em>}
                <div className="muted small">
                  {note.authorName} · {new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))}
          </div>
          <form className="note-form" onSubmit={addNote}>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a note for your teammates…" rows={3} />
            <button className="btn primary wide" type="submit" disabled={!draft.trim()}>
              Add note
            </button>
          </form>
        </>
      )}
    </aside>
  );
}
