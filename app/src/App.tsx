import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router';
import { AppProvider } from '@/store/AppContext';
import { VoiceSessionProvider } from '@/store/VoiceSessionContext';
import { RelayProvider } from '@/store/RelayContext';
import { LocalVrmaRegistryProvider } from '@/store/LocalVrmaRegistryContext';
import Home from './pages/Home';

// Phase 5 — lazy-load the Dashboard + Brain routes.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const BrainView = lazy(() => import('./pages/BrainView'));
const FaceView = lazy(() => import('./pages/FaceView'));
const AvatarShowcase = lazy(() => import('./pages/AvatarShowcase'));

function Fallback() {
  return (
    <div
      className="h-screen w-screen flex items-center justify-center"
      style={{ backgroundColor: 'var(--void-black)', color: 'var(--steel-silver)' }}
    >
      <span className="text-[12px]">Loading…</span>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <VoiceSessionProvider>
        <LocalVrmaRegistryProvider>
          <RelayProvider>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route
                path="/dashboard"
                element={
                  <Suspense fallback={<Fallback />}>
                    <Dashboard />
                  </Suspense>
                }
              />
              <Route
                path="/brain"
                element={
                  <Suspense fallback={<Fallback />}>
                    <BrainView />
                  </Suspense>
                }
              />
              <Route
                path="/face"
                element={
                  <Suspense fallback={<Fallback />}>
                    <FaceView />
                  </Suspense>
                }
              />
              <Route
                path="/avatar-showcase"
                element={
                  <Suspense fallback={<Fallback />}>
                    <AvatarShowcase />
                  </Suspense>
                }
              />
            </Routes>
          </RelayProvider>
        </LocalVrmaRegistryProvider>
      </VoiceSessionProvider>
    </AppProvider>
  );
}
