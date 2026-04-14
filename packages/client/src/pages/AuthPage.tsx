import React, { useState } from 'react';
import { HiOutlineArrowRight } from 'react-icons/hi2';
import { useAuthStore } from '../stores/authStore';
import { signIn, signUp } from '../lib/api';

export default function AuthPage() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('password123');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = isSignUp
        ? await signUp(email, password, displayName)
        : await signIn(email, password);

      if (!result.ok) {
        setError(result.error);
        return;
      }
      login(result.data.token, result.data.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-transparent">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400 drop-shadow-sm">
            Nexus
          </h1>
          <p className="text-neutral-400 text-sm mt-2 font-light">
            Distributed real-time sync engine
          </p>
        </div>

        {/* Card */}
        <div className="card p-8">
          <h2 className="text-lg font-medium text-white mb-6">
            {isSignUp ? 'Create Account' : 'Welcome back'}
          </h2>

          {error && (
            <div className="mb-4 p-3 border border-neutral-700 rounded text-neutral-400 text-xs animate-fade-in">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignUp && (
              <div className="animate-slide-up">
                <label className="block text-xs text-neutral-500 mb-1">Display Name</label>
                <input
                  className="input"
                  placeholder="Your name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required={isSignUp}
                  id="auth-display-name"
                />
              </div>
            )}
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Email</label>
              <input
                className="input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                id="auth-email"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Password</label>
              <input
                className="input"
                type="password"
                placeholder="--------"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                id="auth-password"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full justify-center mt-2"
              id="auth-submit"
            >
              {loading ? (
                <span className="animate-spin inline-block w-4 h-4 border-2 border-black/20 border-t-black rounded-full" />
              ) : (
                <>
                  {isSignUp ? 'Create Account' : 'Sign In'}
                  <HiOutlineArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-5 text-center text-xs text-neutral-600">
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              onClick={() => { setIsSignUp(!isSignUp); setError(''); }}
              className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
              id="auth-toggle"
            >
              {isSignUp ? 'Sign In' : 'Sign Up'}
            </button>
          </div>

          {/* Demo hint */}
          <div className="mt-8 p-4 bg-black/20 rounded-xl border border-white/5 backdrop-blur-sm">
            <p className="text-xs text-neutral-400 font-medium mb-3 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
              Demo Accounts (One-Click Login)
            </p>
            <div className="flex flex-col gap-2">
              {['alice@demo.com', 'bob@demo.com', 'carol@demo.com'].map((demoEmail) => (
                <button
                  key={demoEmail}
                  type="button"
                  disabled={loading}
                  onClick={async () => {
                    setIsSignUp(false);
                    setEmail(demoEmail);
                    setPassword('password123');
                    setError('');
                    setLoading(true);
                    try {
                      const result = await signIn(demoEmail, 'password123');
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      login(result.data.token, result.data.user);
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setLoading(false);
                    }
                  }}
                  className="flex items-center justify-between px-3 py-2 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 rounded-lg text-xs font-mono transition-colors disabled:opacity-50"
                  id={`demo-login-${demoEmail.split('@')[0]}`}
                >
                  <span className="text-neutral-300">{demoEmail}</span>
                  <span className="text-indigo-400 font-sans text-[10px] font-medium tracking-wide uppercase">Login ➝</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
