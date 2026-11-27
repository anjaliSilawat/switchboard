export function LoginPage() {
  return (
    <div className="login-page">
      {/* left side: what the product does, with a small fake chat preview */}
      <section className="login-showcase">
        <div className="brand">
          <span className="logo" />
          Switchboard
        </div>

        <div className="preview">
          <div className="b in">
            Hi, can I change my booking to Friday?
            <small>+1 415 555 0101 · 10:42</small>
          </div>
          <div className="note-chip">Note from Asha: VIP customer, waive the fee</div>
          <div className="b out">
            Of course! Moved to Friday, no extra charge.
            <small>Delivered ✓✓</small>
          </div>
        </div>

        <div>
          <h2>Every customer conversation, one shared inbox.</h2>
          <p>Messages arrive live, one teammate owns each conversation, and private notes stay private to your team.</p>
        </div>
      </section>

      {/* right side: the actual sign-in */}
      <section className="login-side">
        <div className="login-card">
          <span className="logo" />
          <h1>Welcome back</h1>
          <p className="muted">Sign in with your company account to open your team's inbox.</p>

          {/* the server redirects to the identity provider (OIDC + PKCE) */}
          <a className="btn primary wide big" href="/auth/login">
            Continue to sign in →
          </a>

          <ul className="login-steps">
            <li><b>1</b>Pick your workspace after signing in</li>
            <li><b>2</b>Claim a conversation so nobody replies twice</li>
            <li><b>3</b>Unlock notes with your team passphrase</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
