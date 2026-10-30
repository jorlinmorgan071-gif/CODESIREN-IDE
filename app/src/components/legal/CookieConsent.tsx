// app/src/components/legal/CookieConsent.tsx
// Cookie consent banner — shows on first visit, respects user's choice.
// Code Siren only uses essential cookies (no tracking), but the banner
// is required for GDPR/ePrivacy compliance in the EU.

import { useState, useEffect } from 'react';

const CONSENT_KEY = 'code_siren_cookie_consent';
const CONSENT_VALUE = 'accepted';

export function CookieConsent() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(CONSENT_KEY);
    if (!stored) {
      // Show after a short delay so it doesn't flash on page load
      const timer = setTimeout(() => setShow(true), 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  const accept = () => {
    localStorage.setItem(CONSENT_KEY, CONSENT_VALUE);
    setShow(false);
  };

  const dismiss = () => {
    localStorage.setItem(CONSENT_KEY, `dismissed:${Date.now()}`);
    setShow(false);
  };

  if (!show) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 bg-zinc-900 border-t border-zinc-700 p-4 shadow-lg"
      role="dialog"
      aria-live="polite"
      aria-label="Cookie consent"
    >
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center gap-4">
        <div className="flex-1 text-sm text-zinc-300">
          <p>
            We use only <strong>essential cookies</strong> for authentication.
            No tracking, no advertising. See our{' '}
            <a
              href="/legal/cookie-policy.md"
              className="text-blue-400 underline hover:text-blue-300"
              target="_blank"
              rel="noopener noreferrer"
            >
              Cookie Policy
            </a>{' '}
            for details.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={dismiss}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Dismiss
          </button>
          <button
            onClick={accept}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
