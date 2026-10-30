import React, { useEffect, useState } from 'react';
import { Mail, ArrowRight, ShieldCheck, RefreshCw, ChevronLeft, Lock } from 'lucide-react';
import { ThemeSwitcher } from './ThemeSwitcher';
import { apiBase } from '../api/session';

/**
 * What the server can do for sign-in.
 *
 * Given, this screen signs in against the backend: the code is minted and
 * checked on the server, and this page never sees it. Absent, the screen is
 * the local demonstration, which says so on its face — it generates a code in
 * the browser and shows it, and that is only acceptable because there is no
 * account behind it to protect.
 */
export interface LoginServer {
  requestCode(email: string): Promise<{ delivered: boolean; message: string }>;
  signInWithCode(input: { email: string; code: string }): Promise<void>;
  signInWithPassword(input: { email: string; password: string }): Promise<void>;
}

interface LoginScreenProps {
  onLogin: (email: string) => void;
  server?: LoginServer;
}

type Step = 'email' | 'otp' | 'password';

/** What the server's Google callback means by each reason it sends back. */
const GOOGLE_PROBLEMS: Record<string, string> = {
  google_not_registered:
    'That Google account is not registered with the society. Use the Google account whose e-mail the office has on record, or ask the office to add it.',
  google_unverified: 'Google did not confirm that e-mail address, so it cannot be used to sign in.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_state: 'That sign-in attempt expired or did not start here. Please try again.',
  google_failed: 'Google could not be reached to finish signing in. Please try again.',
  google_rate_limited: 'Too many sign-in attempts. Try again shortly.',
  google_not_configured: 'Sign in with Google is not set up on this site.',
};

/** Google's "G", in its own colours, for the sign-in button. */
const GoogleMark = () => (
  <svg className="w-4 h-4" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin, server }) => {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [sentOtp, setSentOtp] = useState('');
  const [serverNote, setServerNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [googleEnabled, setGoogleEnabled] = useState(false);
  // Whether the server can actually deliver a one-time code. Without a
  // provider, offering "Send OTP" sends people to wait for a code that never
  // comes, so the code path is hidden and the password is the way in.
  const [codesDelivered, setCodesDelivered] = useState(server === undefined);

  // Whether the server offers Google sign-in, and what it said if a Google
  // attempt was just refused (it sends the reason back in ?login_error=).
  useEffect(() => {
    if (server === undefined) return;
    let live = true;
    void fetch(`${apiBase()}/api/auth/google/status`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : { enabled: false }))
      .then((b: { enabled?: unknown }) => { if (live) setGoogleEnabled(b.enabled === true); })
      .catch(() => undefined);
    void fetch(`${apiBase()}/api/health`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : {}))
      .then((b: { providers?: { otp?: unknown } }) => {
        if (live) setCodesDelivered(typeof b.providers?.otp === 'string' && b.providers.otp !== 'none');
      })
      .catch(() => undefined);
    const params = new URLSearchParams(window.location.search);
    const problem = params.get('login_error');
    if (problem !== null) {
      setError(GOOGLE_PROBLEMS[problem] ?? 'Google sign-in did not complete. Please try again.');
      params.delete('login_error');
      const rest = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${rest === '' ? '' : `?${rest}`}${window.location.hash}`);
    }
    return () => { live = false; };
  }, [server]);

  const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

  // With Google offered to members, the e-mail form is the committee's, and
  // the committee signs in with a password.
  const continueWithPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!isValidEmail(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    setStep('password');
  };

  const handleSendOtp = (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    if (!isValidEmail(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    if (server !== undefined) {
      setBusy(true);
      void server.requestCode(email.trim().toLowerCase())
        .then(result => {
          // The server's own words. With no delivery provider configured it
          // says so, and this screen repeats that rather than claiming a code
          // is on its way.
          setServerNote(
            result.delivered
              ? result.message
              : `${result.message} (No delivery provider is configured on the server, so no ` +
                'code was actually sent. Use a password instead.)',
          );
          setSentOtp('');
          setOtp('');
          setStep('otp');
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'The server refused that request.');
        })
        .finally(() => setBusy(false));
      return;
    }

    // DEMONSTRATION ONLY: no server, so the code is generated here and shown.
    const code = generateOtp();
    setSentOtp(code);
    setOtp('');
    setStep('otp');
  };

  const handleVerify = (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');

    if (server !== undefined) {
      setBusy(true);
      void server.signInWithCode({ email: email.trim().toLowerCase(), code: otp.trim() })
        .then(() => onLogin(email.trim().toLowerCase()))
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'That code was not accepted.');
        })
        .finally(() => setBusy(false));
      return;
    }

    if (otp.trim() === sentOtp) {
      onLogin(email.trim().toLowerCase());
    } else {
      setError('Incorrect OTP. Please try again.');
    }
  };

  const handlePassword = (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    if (server === undefined) return;
    if (!isValidEmail(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    setBusy(true);
    void server.signInWithPassword({ email: email.trim().toLowerCase(), password })
      .then(() => onLogin(email.trim().toLowerCase()))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'That email and password do not match.');
      })
      .finally(() => { setBusy(false); setPassword(''); });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-[var(--mv-soft)] font-sans text-[var(--mv-ink)]">
      <div className="w-full max-w-[400px] bg-[var(--mv-surface)] rounded-3xl shadow-2xl border border-[var(--mv-border)] overflow-hidden">
        {/* Brand header */}
        <div className="bg-[var(--mv-ink)] px-6 py-7 text-white">
          <div className="flex items-center gap-2.5">
            <div className="mv-logo-tile"><img src="/branding/mani-vista-logo.png" alt="Mani Vista Residents Association" /></div>
            <div className="text-left">
              <h2 className="text-white font-bold leading-none tracking-tight text-sm">MANI VISTA</h2>
              <span className="text-[9px] text-white/70 font-bold block mt-1 uppercase tracking-wider">RESIDENTS ASSOCIATION</span>
            </div>
          </div>
        </div>

        <div className="px-6 pt-4 flex justify-end"><ThemeSwitcher /></div>
        <div className="p-6 pt-3">
          {step === 'password' && server !== undefined ? (
            <form onSubmit={handlePassword}>
              <button
                type="button"
                onClick={() => { setStep('email'); setError(''); }}
                className="flex items-center gap-1 text-[11px] font-bold text-[var(--mv-muted)] hover:text-[var(--mv-accent)] transition-colors mb-3"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Back
              </button>

              <h1 className="text-lg font-extrabold text-[var(--mv-ink)] mb-4">Sign in</h1>

              {/* Always here, filled in if it was typed already: arriving at
                  this form with no e-mail used to leave nowhere to type one. */}
              <label htmlFor="login-password-email" className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Email Address</label>
              <div className="mt-1.5 mb-4 flex items-center gap-2 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl px-3 focus-within:border-[var(--mv-accent)] transition-colors">
                <Mail className="w-4 h-4 text-[var(--mv-muted)] shrink-0" />
                <input
                  id="login-password-email"
                  type="email"
                  autoComplete="username"
                  autoFocus={!isValidEmail(email)}
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  placeholder="you@example.com"
                  className="w-full py-3 bg-transparent outline-none text-sm font-semibold text-[var(--mv-ink)] placeholder:text-[var(--mv-muted)] placeholder:font-normal"
                />
              </div>

              <label htmlFor="login-password" className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Password</label>
              <div className="mt-1.5 flex items-center gap-2 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl px-3 focus-within:border-[var(--mv-accent)] transition-colors">
                <Lock className="w-4 h-4 text-[var(--mv-muted)] shrink-0" />
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus={isValidEmail(email)}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  placeholder="Your password"
                  className="w-full py-3 bg-transparent outline-none text-sm font-semibold text-[var(--mv-ink)] placeholder:text-[var(--mv-muted)] placeholder:font-normal"
                />
              </div>

              {error && (
                <p className="text-[11px] text-red-600 bg-red-50 py-1.5 px-2.5 rounded-lg mt-3 font-semibold">{error}</p>
              )}

              <button
                type="submit"
                disabled={busy || password === ''}
                className="mt-5 w-full py-3 bg-[var(--mv-accent)] text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-60"
              >
                <ShieldCheck className="w-4 h-4" /> {busy ? 'Signing in\u2026' : 'Sign in'}
              </button>
            </form>
          ) : step === 'email' ? (
            <form onSubmit={googleEnabled || !codesDelivered ? continueWithPassword : handleSendOtp}>
              <h1 className="text-lg font-extrabold text-[var(--mv-ink)]">Member Login</h1>
              {googleEnabled ? (
                <>
                  <p className="text-xs text-[var(--mv-muted)] mt-1 mb-4">
                    Members: sign in with the Google account whose e-mail the society has on record.
                  </p>
                  {/* A full navigation, not a fetch: Google's consent screen
                      cannot be shown inside the page. */}
                  <a
                    href={`${apiBase()}/api/auth/google/start`}
                    className="w-full py-3 bg-white text-[#1F1F1F] border border-[#747775] rounded-xl text-sm font-semibold flex items-center justify-center gap-2.5 hover:bg-[#F8F9FA] transition-colors"
                  >
                    <GoogleMark /> Sign in with Google
                  </a>
                  <div className="my-5 flex items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-[var(--mv-muted)]" aria-hidden="true">
                    <span className="h-px flex-1 bg-[var(--mv-border)]" /> Committee <span className="h-px flex-1 bg-[var(--mv-border)]" />
                  </div>
                  <p className="text-xs text-[var(--mv-muted)] -mt-2 mb-4">
                    Committee members can also sign in with their e-mail and password.
                  </p>
                </>
              ) : (
                <p className="text-xs text-[var(--mv-muted)] mt-1 mb-5">
                  {codesDelivered
                    ? 'Enter your registered email to receive a one-time password.'
                    : 'Enter your registered email, then your password.'}
                </p>
              )}

              <label htmlFor="login-email" className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider">Email Address</label>
              <div className="mt-1.5 flex items-center gap-2 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl px-3 focus-within:border-[var(--mv-accent)] transition-colors">
                <Mail className="w-4 h-4 text-[var(--mv-muted)] shrink-0" />
                <input
                  id="login-email"
                  type="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full py-3 bg-transparent outline-none text-sm font-semibold text-[var(--mv-ink)] placeholder:text-[var(--mv-muted)] placeholder:font-normal"
                />
              </div>

              {error && (
                <p className="text-[11px] text-red-600 bg-red-50 py-1.5 px-2.5 rounded-lg mt-3 font-semibold">{error}</p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="mt-5 w-full py-3 bg-[var(--mv-accent)] text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-60"
              >
                {busy ? 'Working\u2026' : googleEnabled ? 'Continue with password' : codesDelivered ? 'Send OTP' : 'Continue'} <ArrowRight className="w-4 h-4" />
              </button>

              {server !== undefined && codesDelivered && (googleEnabled ? (
                <button
                  type="button"
                  onClick={() => handleSendOtp()}
                  className="mt-3 w-full text-[11px] font-bold text-[var(--mv-muted)] hover:text-[var(--mv-accent)] flex items-center justify-center gap-1 transition-colors"
                >
                  <Mail className="w-3 h-3" /> Send a one-time code instead
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setError(''); setStep('password'); }}
                  className="mt-3 w-full text-[11px] font-bold text-[var(--mv-muted)] hover:text-[var(--mv-accent)] flex items-center justify-center gap-1 transition-colors"
                >
                  <Lock className="w-3 h-3" /> Use a password instead
                </button>
              ))}
            </form>
          ) : (
            <form onSubmit={handleVerify}>
              <button
                type="button"
                onClick={() => { setStep('email'); setError(''); }}
                className="flex items-center gap-1 text-[11px] font-bold text-[var(--mv-muted)] hover:text-[var(--mv-accent)] transition-colors mb-3"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Change email
              </button>

              <h1 className="text-lg font-extrabold text-[var(--mv-ink)]">Enter OTP</h1>
              <p className="text-xs text-[var(--mv-muted)] mt-1">
                We sent a 6-digit code to <span className="font-bold text-[var(--mv-ink)]">{email}</span>
              </p>

              {server === undefined ? (
                /* DEMONSTRATION ONLY: there is no server, so the code is
                   generated in this browser and shown here. A real sign-in
                   never shows the code to the page asking for it. */
                <p className="text-[10px] text-[var(--mv-muted)] mt-3 mb-4 bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] py-1.5 px-2.5 rounded-lg inline-block">
                  Demonstration mode {'\u2014'} no server, so the code is generated here:{' '}
                  <strong className="text-[var(--mv-accent)] tracking-widest">{sentOtp}</strong>
                </p>
              ) : (
                <p className="text-[10px] text-[var(--mv-muted)] mt-3 mb-4 bg-[var(--mv-page)] border border-[var(--mv-border)] py-1.5 px-2.5 rounded-lg">
                  {serverNote}
                </p>
              )}

              <label htmlFor="login-otp" className="text-[10px] font-bold text-[var(--mv-muted)] uppercase tracking-wider block">One-Time Password</label>
              <input
                id="login-otp"
                type="text"
                inputMode="numeric"
                autoFocus
                maxLength={6}
                value={otp}
                onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '')); setError(''); }}
                placeholder="------"
                className="mt-1.5 w-full py-3 px-4 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl outline-none focus:border-[var(--mv-accent)] transition-colors text-center text-2xl font-extrabold tracking-[0.5em] text-[var(--mv-ink)] placeholder:tracking-[0.3em] placeholder:text-[var(--mv-muted)]"
              />

              {error && (
                <p className="text-[11px] text-red-600 bg-red-50 py-1.5 px-2.5 rounded-lg mt-3 font-semibold">{error}</p>
              )}

              <button
                type="submit"
                disabled={busy || otp.trim().length < 6}
                className="mt-5 w-full py-3 bg-[var(--mv-accent)] text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.99] transition-all disabled:opacity-60"
              >
                <ShieldCheck className="w-4 h-4" /> {busy ? 'Checking\u2026' : 'Verify & Login'}
              </button>

              <button
                type="button"
                onClick={() => handleSendOtp()}
                className="mt-3 w-full text-[11px] font-bold text-[var(--mv-muted)] hover:text-[var(--mv-accent)] flex items-center justify-center gap-1 transition-colors"
              >
                <RefreshCw className="w-3 h-3" /> Resend OTP
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
