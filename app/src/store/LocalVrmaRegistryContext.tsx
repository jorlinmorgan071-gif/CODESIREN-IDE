// app/src/store/LocalVrmaRegistryContext.tsx
// Browser-session-only Local VRMA library shared by Face View, PIP, and Bubble.
// Entries are revocable object URLs only: they are never sent to the API, saved
// in settings, added to the avatar manifest, or persisted between page loads.

/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createLocalVrmaSession,
  removeLocalVrmaRegistryEntry,
  revokeLocalVrmaRegistry,
  revokeLocalVrmaSession,
  setLocalVrmaRegistryEntry,
  type LocalVrmaRegistry,
  type LocalVrmaTargetState,
} from '@/lib/local-vrma-session';

interface LocalVrmaRegistryContextValue {
  animationRegistry: LocalVrmaRegistry;
  addOrReplaceLocalVrma: (file: File, targetState: LocalVrmaTargetState) => void;
  removeLocalVrma: (targetState: LocalVrmaTargetState) => void;
}

const LocalVrmaRegistryContext = createContext<LocalVrmaRegistryContextValue | null>(null);

export function LocalVrmaRegistryProvider({ children }: { children: ReactNode }) {
  const [animationRegistry, setAnimationRegistry] = useState<LocalVrmaRegistry>({});
  const registryRef = useRef<LocalVrmaRegistry>({});

  const addOrReplaceLocalVrma = useCallback((file: File, targetState: LocalVrmaTargetState) => {
    const session = createLocalVrmaSession(file, targetState);
    const existing = registryRef.current[targetState];
    if (existing) revokeLocalVrmaSession(existing);

    const nextRegistry = setLocalVrmaRegistryEntry(registryRef.current, session);
    registryRef.current = nextRegistry;
    setAnimationRegistry(nextRegistry);
  }, []);

  const removeLocalVrma = useCallback((targetState: LocalVrmaTargetState) => {
    const existing = registryRef.current[targetState];
    if (!existing) return;

    revokeLocalVrmaSession(existing);
    const nextRegistry = removeLocalVrmaRegistryEntry(registryRef.current, targetState);
    registryRef.current = nextRegistry;
    setAnimationRegistry(nextRegistry);
  }, []);

  useEffect(() => {
    return () => revokeLocalVrmaRegistry(registryRef.current);
  }, []);

  const value = useMemo<LocalVrmaRegistryContextValue>(() => ({
    animationRegistry,
    addOrReplaceLocalVrma,
    removeLocalVrma,
  }), [animationRegistry, addOrReplaceLocalVrma, removeLocalVrma]);

  return (
    <LocalVrmaRegistryContext.Provider value={value}>
      {children}
    </LocalVrmaRegistryContext.Provider>
  );
}

export function useLocalVrmaRegistry() {
  const context = useContext(LocalVrmaRegistryContext);
  if (!context) {
    throw new Error('useLocalVrmaRegistry must be used within LocalVrmaRegistryProvider.');
  }
  return context;
}
