export function LoginPage() {
  return (
    <div className="login-page">
      <div className="login-card">
        <span className="logo big">S</span>
        <h1>Switchboard</h1>
        <p className="muted">One shared inbox for your support team. See customer messages live, claim a conversation, reply, and leave private notes for your teammates.</p>

        {/* the server redirects to the identity provider (OIDC + PKCE) */}
        <a className="btn primary wide" href="/auth/login">
          Sign in with your company account
        </a>

        <ul className="features">
          <li>⚡ Real-time inbox</li>
          <li>✅ Delivery status on every reply</li>
          <li>🔒 End-to-end encrypted notes</li>
        </ul>
      </div>
    </div>
  );
}
