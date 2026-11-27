// OIDC authorization code + PKCE against the mock IdP.
// Login state (PKCE verifier, nonce) and sessions live in Redis, so /auth/login
// and /auth/callback may hit different server copies.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { getRedis } from './redis.js';

export interface Session {
  sub: string;
  name?: string;
  email?: string;
  workspaces: { id: string; role: 'admin' | 'agent' }[];
}

const COOKIE = 'sb_session';
const SESSION_TTL_S = 8 * 3600;
const b64url = (b: Buffer) => b.toString('base64url');

let discovery: Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }> | undefined;
function oidc() {
  discovery ??= fetch(`${config.oidc.issuer}/.well-known/openid-configuration`)
    .then((r) => {
      if (!r.ok) throw new Error(`discovery ${r.status}`);
      return r.json();
    })
    .catch((e) => {
      discovery = undefined;
      throw e;
    });
  return discovery;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function sessionFromCookie(header: string | undefined): Promise<Session | null> {
  const id = parseCookies(header)[COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{20,}$/.test(id)) return null;
  const raw = await getRedis().get(`sess:${id}`);
  return raw ? (JSON.parse(raw) as Session) : null;
}

const secureCookie = () => config.oidc.redirectUri.startsWith('https://');

export async function login(_req: Request, res: Response) {
  const { authorization_endpoint } = await oidc();
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  await getRedis().set(`oidc:${state}`, JSON.stringify({ verifier, nonce }), 'EX', 600);
  const url = new URL(authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  }).toString();
  res.redirect(302, url.toString());
}

export async function callback(req: Request, res: Response) {
  const code = String(req.query.code ?? '');
  const state = String(req.query.state ?? '');
  // GETDEL: a state can be used once
  const saved = state && (await getRedis().getdel(`oidc:${state}`));
  if (!code || !saved) return res.status(400).send('Login expired or invalid. Start again at /auth/login');
  const { verifier } = JSON.parse(saved) as { verifier: string };
  const { token_endpoint, userinfo_endpoint } = await oidc();
  const tok = await fetch(token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: verifier,
    }),
  });
  if (!tok.ok) return res.status(401).send('Token exchange failed');
  const { access_token } = (await tok.json()) as { access_token: string };
  // Identity and workspaces from userinfo, fetched server-to-server with the
  // access token we just received (so no JWT signature check is needed here).
  const ui = await fetch(userinfo_endpoint, { headers: { authorization: `Bearer ${access_token}` } });
  if (!ui.ok) return res.status(401).send('Userinfo failed');
  const u = (await ui.json()) as Session;
  const session: Session = {
    sub: u.sub,
    name: u.name,
    email: u.email,
    workspaces: (u.workspaces ?? []).filter((w) => w && typeof w.id === 'string' && (w.role === 'admin' || w.role === 'agent')),
  };
  const id = b64url(randomBytes(32));
  await getRedis().set(`sess:${id}`, JSON.stringify(session), 'EX', SESSION_TTL_S);
  res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: secureCookie(), path: '/', maxAge: SESSION_TTL_S * 1000 });
  // back to the app: this server when it serves the built UI, else the Vite dev server
  res.redirect(302, existsSync(new URL('../../web/dist/index.html', import.meta.url)) ? '/' : config.webOrigin);
}

export async function logout(req: Request, res: Response) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  if (id) await getRedis().del(`sess:${id}`);
  res.clearCookie(COOKIE, { path: '/' });
  res.status(204).end();
}

// --- middleware ---
declare module 'express-serve-static-core' {
  interface Request {
    session?: Session;
    role?: 'admin' | 'agent';
  }
}

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const s = await sessionFromCookie(req.headers.cookie).catch(() => null);
  if (!s) return res.status(401).json({ error: 'not signed in' });
  req.session = s;
  next();
}

// workspace from ?workspace=; 403 if not a member
export function requireMember(req: Request, res: Response, next: NextFunction) {
  const ws = String(req.query.workspace ?? '');
  const m = req.session?.workspaces.find((w) => w.id === ws);
  if (!m) return res.status(403).json({ error: 'not a member of this workspace' });
  req.role = m.role;
  next();
}
