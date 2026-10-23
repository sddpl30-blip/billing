import React, { useState } from 'react';
import { Mail, ArrowRight, ShieldCheck, RefreshCw, ChevronLeft, Lock } from 'lucide-react';
import { ThemeSwitcher } from './ThemeSwitcher';

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

  const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

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
      <div className="w-full max-w-[400px] bg-white rounded-3xl shadow-2xl border border-[var(--mv-border)] overflow-hidden">
        {/* Brand header */}
        <div className="bg-[var(--mv-ink)] px-6 py-7 text-white">
          <div className="flex items-center gap-2.5">
            <div className="mv-logo-tile"><img src="/branding/mani-vista-logo.png" alt="Mani Vista Residents Association" /></div>
            <div className="text-left">
              <h2 className="text-white font-bold leading-none tracking-tight text-sm">MANI VISTA</h2>
              <span className="text-[9px] text-gray-400 font-bold block mt-1 uppercase tracking-wider">RESIDENTS ASSOCIATION</span>
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
                className="flex items-center gap-1 text-[11px] font-bold text-gray-500 hover:text-[var(--mv-accent)] transition-colors mb-3"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Back
              </button>

              <h1 className="text-lg font-extrabold text-[var(--mv-ink)]">Sign in</h1>
              <p className="text-xs text-gray-500 mt-1 mb-5">
                <span className="font-bold text-[var(--mv-ink)]">{email}</span>
              </p>

              <label htmlFor="login-password" className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Password</label>
              <div className="mt-1.5 flex items-center gap-2 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl px-3 focus-within:border-[var(--mv-accent)] transition-colors">
                <Lock className="w-4 h-4 text-gray-400 shrink-0" />
                <input
                  id="login-password"
                  type="password"
                  autoFocus
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  placeholder="Your password"
                  className="w-full py-3 bg-transparent outline-none text-sm font-semibold text-[var(--mv-ink)] placeholder:text-gray-400 placeholder:font-normal"
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
            <form onSubmit={handleSendOtp}>
              <h1 className="text-lg font-extrabold text-[var(--mv-ink)]">Member Login</h1>
              <p className="text-xs text-gray-500 mt-1 mb-5">
                Enter your registered email to receive a one-time password.
              </p>

              <label htmlFor="login-email" className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider">Email Address</label>
              <div className="mt-1.5 flex items-center gap-2 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl px-3 focus-within:border-[var(--mv-accent)] transition-colors">
                <Mail className="w-4 h-4 text-gray-400 shrink-0" />
                <input
                  id="login-email"
                  type="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full py-3 bg-transparent outline-none text-sm font-semibold text-[var(--mv-ink)] placeholder:text-gray-400 placeholder:font-normal"
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
                {busy ? 'Working\u2026' : 'Send OTP'} <ArrowRight className="w-4 h-4" />
              </button>

              {server !== undefined && (
                <button
                  type="button"
                  onClick={() => { setError(''); setStep('password'); }}
                  className="mt-3 w-full text-[11px] font-bold text-gray-500 hover:text-[var(--mv-accent)] flex items-center justify-center gap-1 transition-colors"
                >
                  <Lock className="w-3 h-3" /> Use a password instead
                </button>
              )}
            </form>
          ) : (
            <form onSubmit={handleVerify}>
              <button
                type="button"
                onClick={() => { setStep('email'); setError(''); }}
                className="flex items-center gap-1 text-[11px] font-bold text-gray-500 hover:text-[var(--mv-accent)] transition-colors mb-3"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Change email
              </button>

              <h1 className="text-lg font-extrabold text-[var(--mv-ink)]">Enter OTP</h1>
              <p className="text-xs text-gray-500 mt-1">
                We sent a 6-digit code to <span className="font-bold text-[var(--mv-ink)]">{email}</span>
              </p>

              {server === undefined ? (
                /* DEMONSTRATION ONLY: there is no server, so the code is
                   generated in this browser and shown here. A real sign-in
                   never shows the code to the page asking for it. */
                <p className="text-[10px] text-gray-500 mt-3 mb-4 bg-[var(--mv-accent-soft)] border border-[var(--mv-accent-border)] py-1.5 px-2.5 rounded-lg inline-block">
                  Demonstration mode {'\u2014'} no server, so the code is generated here:{' '}
                  <strong className="text-[var(--mv-accent)] tracking-widest">{sentOtp}</strong>
                </p>
              ) : (
                <p className="text-[10px] text-gray-600 mt-3 mb-4 bg-[var(--mv-page)] border border-[var(--mv-border)] py-1.5 px-2.5 rounded-lg">
                  {serverNote}
                </p>
              )}

              <label htmlFor="login-otp" className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wider block">One-Time Password</label>
              <input
                id="login-otp"
                type="text"
                inputMode="numeric"
                autoFocus
                maxLength={6}
                value={otp}
                onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '')); setError(''); }}
                placeholder="------"
                className="mt-1.5 w-full py-3 px-4 bg-[var(--mv-page)] border border-[var(--mv-border)] rounded-xl outline-none focus:border-[var(--mv-accent)] transition-colors text-center text-2xl font-extrabold tracking-[0.5em] text-[var(--mv-ink)] placeholder:tracking-[0.3em] placeholder:text-gray-300"
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
                className="mt-3 w-full text-[11px] font-bold text-gray-500 hover:text-[var(--mv-accent)] flex items-center justify-center gap-1 transition-colors"
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
