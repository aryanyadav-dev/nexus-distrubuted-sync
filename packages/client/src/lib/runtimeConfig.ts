type ImportMetaEnvLike = ImportMeta & {
  env?: Record<string, string | undefined>;
};

function readEnv(key: string): string | undefined {
  return (import.meta as ImportMetaEnvLike).env?.[key];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

export function getApiBaseUrl(): string {
  const explicitApiUrl = readEnv('VITE_API_URL');
  if (explicitApiUrl) return trimTrailingSlash(explicitApiUrl);
  return '/api';
}

export function getWsUrl(): string {
  const explicitWsUrl = readEnv('VITE_WS_URL');
  if (explicitWsUrl) return explicitWsUrl;

  const apiBaseUrl = getApiBaseUrl();
  if (/^https?:\/\//.test(apiBaseUrl)) {
    return apiBaseUrl.replace(/^http/, 'ws').replace(/\/api$/, '/ws');
  }

  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
}
