const SCANNER_CHANNEL_KEY = 'znnpos_scanner_channel';

const createChannelId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const randomPart = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${randomPart}`;
};

export const getScannerChannel = () => {
  const existingChannel = localStorage.getItem(SCANNER_CHANNEL_KEY);
  if (existingChannel && /^[a-z0-9-]{8,80}$/i.test(existingChannel)) return existingChannel;

  const newChannel = createChannelId();
  localStorage.setItem(SCANNER_CHANNEL_KEY, newChannel);
  return newChannel;
};
