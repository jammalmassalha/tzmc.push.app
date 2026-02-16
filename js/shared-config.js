(() => {
  const config = {
    DB_NAME: 'PushNotificationsDB',
    STORE_NAME: 'history',
    OUTBOX_STORE: 'outbox',
    DB_VERSION: 4,
    CACHE_NAME: 'static-assets-v34',
    VAPID_PUBLIC_KEY: 'BNgK2Le8hUyXIrFeuHJJsHwjOUkK5y5bf46QH80Ybd1AoQFfQDEanVCfjo9HwqdJwWoD2-2pxxgTRdTasf9YYMk',
    SUBSCRIPTION_URL: 'https://www.tzmc.co.il/notify/subscription',
    NOTIFY_SERVER_URL: 'https://www.tzmc.co.il/notify/reply',
    UPLOAD_SERVER_URL: 'https://www.tzmc.co.il/notify/upload',
    GROUP_UPDATE_URL: 'https://www.tzmc.co.il/notify/group-update',
    GROUPS_URL: 'https://www.tzmc.co.il/notify/groups',
    REACTION_URL: 'https://www.tzmc.co.il/notify/reaction',
    VERSION_CHECK_URL: 'https://www.tzmc.co.il/notify/version',
    VERIFY_STATUS_URL: 'https://www.tzmc.co.il/notify/verify-status',
    LOG_SERVER_URL: 'https://www.tzmc.co.il/notify/log'
  };

  if (typeof self !== 'undefined') {
    self.APP_CONFIG = Object.assign({}, self.APP_CONFIG || {}, config);
  }
  if (typeof window !== 'undefined') {
    window.APP_CONFIG = Object.assign({}, window.APP_CONFIG || {}, config);
  }
})();