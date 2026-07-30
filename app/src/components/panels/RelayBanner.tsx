// app/src/components/panels/RelayBanner.tsx
// Directive Section 2.3 — persistent banner that appears when the
// orchestrator is waiting for user advance (default-approval mode).
//
// Shows: "{summary} — [Approve & Continue] [Stop]"
// Hidden when no plan is awaiting user input.

import { motion, AnimatePresence } from 'motion/react';
import { Check, Square, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useRelay } from '@/store/RelayContext';

export function RelayBanner() {
  const relay = useRelay();
  const [advancing, setAdvancing] = useState(false);
  const [stopping, setStopping] = useState(false);

  const isVisible = relay.status === 'awaiting-user' && relay.awaitingSummary !== null;

  const handleAdvance = async () => {
    setAdvancing(true);
    try {
      await relay.advance();
    } finally {
      setAdvancing(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await relay.stop();
    } finally {
      setStopping(false);
    }
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ y: -60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -60, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-2xl px-4"
        >
          <div
            className="rounded-lg px-4 py-3 flex items-center gap-3"
            style={{
              backgroundColor: '#15151E',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            }}
          >
            <div
              className="w-2 h-2 rounded-full flex-shrink-0 animate-pulse"
              style={{ backgroundColor: '#F59E0B' }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] uppercase tracking-wider font-medium" style={{ color: '#F59E0B' }}>
                Milestone approved — awaiting your input
              </div>
              <div className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--bright-silver)' }}>
                {relay.awaitingSummary}
              </div>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button
                onClick={handleAdvance}
                disabled={advancing || stopping}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: 'var(--siren-red)',
                  color: 'white',
                }}
              >
                {advancing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                Approve &amp; Continue
              </button>
              <button
                onClick={handleStop}
                disabled={advancing || stopping}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--steel-silver)',
                }}
              >
                {stopping ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Square className="w-3 h-3" />
                )}
                Stop
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
