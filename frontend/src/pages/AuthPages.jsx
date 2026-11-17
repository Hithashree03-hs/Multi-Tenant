import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { Alert, Button, Field, Loading } from "../components/ui.jsx";

function AuthFrame({ title, description, children, footer }) {
  return <main className="auth-page">
    <div className="auth-art" aria-hidden="true"><div className="auth-art-top"><span className="brand-mark">C</span><span>CampusFlow Pro</span></div>
      <div className="auth-art-copy"><span className="eyebrow">YOUR CAMPUS, IN FLOW</span><h1>Make room for the work that matters.</h1><p>A clearer way to connect people, learning, and campus projects.</p>
        <div className="auth-art-shapes"><span /><span /><span /></div>
      </div><span className="auth-art-footer">A calmer campus workspace</span>
    </div>
    <section className="auth-panel"><div className="auth-mobile-brand"><span className="brand-mark">C</span><span>CampusFlow Pro</span></div>
      <div className="auth-card"><div className="eyebrow">CAMPUSFLOW ACCOUNT</div><h2>{title}</h2><p className="muted">{description}</p>{children}<div className="auth-footer">{footer}</div></div>
      <div className="auth-legal">Secure access for your campus community</div>
    </section>
  </main>;
}

export function LoginPage() {
  const { login, isAuthenticated, isInitializing } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (isInitializing) return <div className="auth-restore"><Loading label="Checking your session…" /></div>;
  if (isAuthenticated) return <Navigate to="/" replace />;

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const submittedPassword = password;
    setPassword("");
    try {
      await login(email.trim(), submittedPassword);
      navigate(location.state?.from || "/", { replace: true });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <AuthFrame title="Welcome back" description="Sign in to continue to your campus workspace."
    footer={<>New to CampusFlow? <Link to="/register">Create a student account</Link></>}>
    <form className="stack-form" onSubmit={submit}>
      <Alert variant="info">{location.state?.message}</Alert>
      <Alert>{error}</Alert>
      <Field label="Email address" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
      <Button type="submit" disabled={busy} className="button-full">{busy ? "Signing in…" : "Sign in"}</Button>
    </form>
  </AuthFrame>;
}

export function RegisterPage() {
  const { register, isAuthenticated, isInitializing } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  if (isInitializing) return <div className="auth-restore"><Loading label="Checking your session…" /></div>;
  if (isAuthenticated) return <Navigate to="/" replace />;

  function update(event) { setForm((current) => ({ ...current, [event.target.name]: event.target.value })); }
  async function submit(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    const submitted = { ...form };
    setForm((current) => ({ ...current, password: "" }));
    try {
      const user = await register(submitted.name.trim(), submitted.email.trim(), submitted.password);
      setSuccess(`Your student account is ready, ${user.name}. Sign in to continue.`);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <AuthFrame title="Create your account" description="Join your campus workspace as a student."
    footer={<>Already registered? <Link to="/login">Sign in</Link></>}>
    <form className="stack-form" onSubmit={submit}>
      <Alert>{error}</Alert>{success && <Alert variant="success">{success} <Link to="/login">Sign in now</Link></Alert>}
      <Field label="Full name" name="name" type="text" autoComplete="name" required maxLength={120} value={form.name} onChange={update} />
      <Field label="Campus email" name="email" type="email" autoComplete="email" required maxLength={254} value={form.email} onChange={update} />
      <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={form.password} onChange={update} hint="Use at least 8 characters." />
      <p className="form-note">Student accounts join the campus organization configured by your administrator.</p>
      <Button type="submit" disabled={busy || Boolean(success)} className="button-full">{busy ? "Creating account…" : "Create account"}</Button>
    </form>
  </AuthFrame>;
}
