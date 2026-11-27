// Small helper around fetch. Every call sends the session cookie.

export type Role = 'admin' | 'agent';

export interface Me {
  sub: string;
  name?: string;
  workspaces: { id: string; role: Role }[];
}

export interface Conversation {
  contact: string;
  assignee: string | null;
  assigneeName?: string | null;
  state: 'open' | 'closed';
  lastActivityAt: string;
}

export interface Message {
  dir: 'in' | 'out';
  id: string;
  text: string;
  at: string;
  status?: string;
}

export interface Note {
  id: string;
  authorName: string;
  ciphertext: string;
  iv: string;
  createdAt: string;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body: body as T };
}
