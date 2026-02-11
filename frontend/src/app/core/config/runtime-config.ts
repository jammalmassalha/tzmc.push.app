export interface RuntimeConfig {
  dbName: string;
  storeName: string;
  outboxStore: string;
  vapidPublicKey: string;
  subscriptionUrl: string;
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

export const runtimeConfig: RuntimeConfig = {
  dbName: 'PushNotificationsDB',
  storeName: 'history',
  outboxStore: 'outbox',
  vapidPublicKey: 'BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk',
  subscriptionUrl: 'https://script.google.com/macros/s/AKfycbz3GUA0gi9YowpIqwxu_Bh1z-os2_SwHv7m8aRC7K4LXX4bBtn-mB9MWWkHQYJ_QSryww/exec',
  notifyReplyUrl: `${backendOrigin}/notify/reply`,
  uploadUrl: `${backendOrigin}/notify/upload`,
  groupUpdateUrl: `${backendOrigin}/notify/group-update`,
  reactionUrl: `${backendOrigin}/notify/reaction`,
  groupsUrl: `${backendOrigin}/notify/groups`,
  versionUrl: `${backendOrigin}/notify/version`
};

export const SYSTEM_CHAT_IDS = ['ציפי'] as const;

export function getNotifyBaseUrl(notifyReplyUrl: string): string {
  if (notifyReplyUrl.endsWith('/reply')) {
    return notifyReplyUrl.slice(0, -'/reply'.length);
  }

  return notifyReplyUrl;
}
