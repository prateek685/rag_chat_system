'use client';

import { useEffect, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { readStorage, writeStorage, SESSION_KEY } from '@/lib/storage';
import { setApiSessionId } from '@/lib/api';

/**
 * Initializes and persists the browser session UUID.
 * Returns '' during SSR to prevent hydration mismatch; real UUID is set in
 * the first useEffect after mount.
 */
export function useSession(): string {
  const [sessionId, setSessionId] = useState<string>('');

  useEffect(() => {
    let id = readStorage<string>(SESSION_KEY, '');
    if (!id) {
      id = uuid();
      writeStorage(SESSION_KEY, id);
    }
    setApiSessionId(id);
    setSessionId(id);
  }, []);

  return sessionId;
}
