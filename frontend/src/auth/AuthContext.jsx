import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import { AuthContext } from './authContextValue';

const AUTH_TOKEN_KEY = 'znnpos_auth_token';
const DEVICE_ID_KEY = 'znncashier_device_id';

const getDeviceId = () => {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const generated = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    return '';
  }
};

const clearStoredSession = () => {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
};

const storeSession = (session) => {
  sessionStorage.setItem(AUTH_TOKEN_KEY, session.token);
  return session.user;
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState('loading');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const loadSession = async () => {
      try {
        if (sessionStorage.getItem(AUTH_TOKEN_KEY)) {
          const response = await api.get('/auth/me');
          if (!mounted) return;
          setUser(response.data.user);
          setAuthMode('authenticated');
          setLoading(false);
          return;
        }

        const response = await api.get('/auth/status');
        if (!mounted) return;
        setAuthMode(response.data.configured ? 'login' : 'bootstrap');
      } catch {
        if (mounted) setAuthMode('login');
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadSession();
    return () => { mounted = false; };
  }, []);

  const login = async (username, pin, storeCode = 'utama') => {
    const response = await api.post('/auth/login', { username, pin, store_code: storeCode, device_id: getDeviceId() });
    const loggedInUser = storeSession(response.data);
    setUser(loggedInUser);
    setAuthMode('authenticated');
    return loggedInUser;
  };

  const bootstrap = async (username, pin) => {
    const response = await api.post('/auth/bootstrap', { username, pin });
    const bootstrappedUser = storeSession(response.data);
    setUser(bootstrappedUser);
    setAuthMode('authenticated');
    return bootstrappedUser;
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      clearStoredSession();
      setUser(null);
      setAuthMode('login');
    }
  };

  const updateUser = (updates) => {
    setUser((currentUser) => currentUser ? { ...currentUser, ...updates } : currentUser);
  };

  const value = useMemo(() => ({ user, authMode, loading, login, bootstrap, logout, updateUser }), [user, authMode, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
