export interface RuntimeConfig {
  dbName: string;
  storeName: string;
  outboxStore: string;
  vapidPublicKey: string;
  subscriptionUrl: string;
  notifyReplyUrl: string;
  uploadUrl: string;
  groupUpdateUrl: string;
  groupsUrl: string;
  versionUrl: string;
}

export const runtimeConfig: RuntimeConfig = {
  dbName: 'PushNotificationsDB',
  storeName: 'history',
  outboxStore: 'outbox',
  vapidPublicKey: 'BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk',
  subscriptionUrl: 'https://script.google.com/macros/s/AKfycbxTzd4oEqs_3vGEObKpFUPcDjQbjuiOiFKDjUm6Kvvh2zsdzhu7zGrcewnuWrtEExbC/exec',
  notifyReplyUrl: 'https://www.tzmc.co.il/notify/reply',
  uploadUrl: 'https://www.tzmc.co.il/notify/upload',
  groupUpdateUrl: 'https://www.tzmc.co.il/notify/group-update',
  groupsUrl: 'https://www.tzmc.co.il/notify/groups',
  versionUrl: 'https://www.tzmc.co.il/notify/version'
};

export const SYSTEM_CHAT_IDS = ['ציפי'] as const;

export function getNotifyBaseUrl(notifyReplyUrl: string): string {
  if (notifyReplyUrl.endsWith('/reply')) {
    return notifyReplyUrl.slice(0, -'/reply'.length);
  }

  return notifyReplyUrl;
}
