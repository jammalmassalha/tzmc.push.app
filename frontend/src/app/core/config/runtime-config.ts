export interface RuntimeConfig {
  dbName: string;
  storeName: string;
  outboxStore: string;
  vapidPublicKey: string;
  subscriptionUrl: string;
  shuttleSheetUrl: string;
  shuttleUserOrdersUrl: string;
  notifyReplyUrl: string;
  uploadUrl: string;
  groupUpdateUrl: string;
  reactionUrl: string;
  groupsUrl: string;
  versionUrl: string;
}

const DEFAULT_REMOTE_ORIGIN = 'https://www.tzmc.co.il';

function resolveBackendOrigin(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_REMOTE_ORIGIN;
  }

  const origin = window.location.origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return DEFAULT_REMOTE_ORIGIN;
  }

  return origin;
}

const backendOrigin = resolveBackendOrigin();

type RuntimeConfigOverrides = Partial<RuntimeConfig>;

function getRuntimeOverrides(): RuntimeConfigOverrides {
  if (typeof window === 'undefined') {
    return {};
  }
  const candidate = (window as Window & { __TZMC_RUNTIME_CONFIG__?: RuntimeConfigOverrides }).__TZMC_RUNTIME_CONFIG__;
  if (!candidate || typeof candidate !== 'object') {
    return {};
  }
  return candidate;
}

function withOverride<K extends keyof RuntimeConfig>(
  key: K,
  fallback: RuntimeConfig[K]
): RuntimeConfig[K] {
  const overrides = getRuntimeOverrides();
  const value = overrides[key];
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized) {
      return normalized as RuntimeConfig[K];
    }
  }
  return fallback;
}

export const runtimeConfig: RuntimeConfig = {
  dbName: 'PushNotificationsDB',
  storeName: 'history',
  outboxStore: 'outbox',
  vapidPublicKey: withOverride('vapidPublicKey', 'BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk'),
  subscriptionUrl: withOverride('subscriptionUrl', 'https://script.google.com/macros/s/AKfycbwvnlvHlDCEpMZmKRfXbaxwiO61I9AxIZcyMEyZsgRoYb4HbsflTXGmFpANkXj4QKcYLA/exec'),
  shuttleSheetUrl: withOverride('shuttleSheetUrl', 'https://script.google.com/macros/s/AKfycbxpFfOokS0-DzisejboqjZtJW3OLjMmPvMt-sZqNwSU5ohN940811XulyDdHEpmDHsY/exec'),
  shuttleUserOrdersUrl: withOverride('shuttleUserOrdersUrl', 'https://script.google.com/macros/s/AKfycbxpFfOokS0-DzisejboqjZtJW3OLjMmPvMt-sZqNwSU5ohN940811XulyDdHEpmDHsY/exec'),
  notifyReplyUrl: withOverride('notifyReplyUrl', `${backendOrigin}/notify/reply`),
  uploadUrl: withOverride('uploadUrl', `${backendOrigin}/notify/upload`),
  groupUpdateUrl: withOverride('groupUpdateUrl', `${backendOrigin}/notify/group-update`),
  reactionUrl: withOverride('reactionUrl', `${backendOrigin}/notify/reaction`),
  groupsUrl: withOverride('groupsUrl', `${backendOrigin}/notify/groups`),
  versionUrl: withOverride('versionUrl', `${backendOrigin}/notify/version`)
};

export const SYSTEM_CHAT_IDS = ['ציפי', 'הזמנת הסעה'] as const;

export function getNotifyBaseUrl(notifyReplyUrl: string): string {
  if (notifyReplyUrl.endsWith('/reply')) {
    return notifyReplyUrl.slice(0, -'/reply'.length);
  }

  return notifyReplyUrl;
}
