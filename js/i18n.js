(() => {
  const DEFAULT_LANG = (document.documentElement.getAttribute('lang') || 'he').toLowerCase();
  const translations = {
    he: {
      status_requesting_permission: 'מבקש הרשאה...',
      status_failed_install: 'נכשל. נסה להוסיף למסך הבית תחילה.',
      status_invalid_phone: 'מספר לא תקין. הזן מספר נייד תקף.',
      status_empty_input: 'נא להזין מספר נייד.',
      status_offline_queue: 'אין חיבור. ההודעה תישלח כשיתחבר.',
      status_upload_failed: 'שגיאה בהעלאה.',
      status_uploading: 'מעלה',
      status_backup_start: 'מתחיל גיבוי...',
      status_backup_done: 'הגיבוי הושלם.',
      status_backup_empty: 'לא נמצאו שיחות לגיבוי.',
      status_backup_failed: 'שגיאה בגיבוי.',
      status_chat_deleted: 'השיחה נמחקה.',
      status_all_cleared: 'כל השיחות נמחקו.',
      status_location_error: 'לא ניתן לקבל מיקום. אנא אשר הרשאות.',
      status_send_failed: 'שליחה נכשלה. ננסה שוב.',
      confirm_clear_all: 'למחוק את כל היסטוריית הצ׳אט מהמכשיר?',
      confirm_delete_chat: 'למחוק את השיחה עם {name}?',
      confirm_delete_current: 'למחוק את השיחה הנוכחית?',
      confirm_yes: 'כן',
      confirm_no: 'לא',
      network_online: 'מקוון',
      network_offline: 'לא מחובר',
      delete_for_me: 'מחק עבורי',
      delete_for_everyone: 'מחיקה לכולם',
      delete_close: 'סגור',
      toast_info: 'מידע',
      toast_error: 'שגיאה',
      toast_success: 'בוצע',
      bot_welcome: 'שלום! בחרת בקטגוריה {category}. כדי להתחיל, הזן מספר תעודת זהות:',
      bot_first_name: 'תודה. מה השם הפרטי שלך?',
      bot_last_name: 'מעולה. מה שם המשפחה שלך?',
      bot_phone: 'לבסוף, מה מספר הנייד שלך?',
      bot_loading_departments: 'מחפש מחלקות...',
      bot_select_department: 'בחר מחלקה לפי מספר:',
      bot_invalid_number: 'מספר לא תקין. נסה שוב.',
      bot_loading_actions: 'טוען נושאים...',
      bot_select_action: 'בחר את הנושא הרלוונטי:',
      bot_registering: 'תודה! שולח את הבקשה...',
      bot_no_actions: 'לא נמצאו נושאים. שולח בקשה כללית.',
      bot_error_departments: 'שגיאה בטעינת מחלקות. נסה שוב מאוחר יותר.',
      bot_error_actions: 'שגיאה בטעינת נושאים.',
      bot_support_logged: 'הבקשה נרשמה וההתראות הופעלו.',
      bot_support_error: 'שגיאת חיבור, ננסה לטפל בבקשה.'
    },
    en: {
      status_requesting_permission: 'Requesting permission...',
      status_failed_install: 'Failed. Try adding to Home Screen first.',
      status_invalid_phone: 'Invalid number. Enter a valid phone.',
      status_empty_input: 'Please enter a phone number.',
      status_offline_queue: 'Offline. Message will send when online.',
      status_upload_failed: 'Upload failed.',
      status_uploading: 'Uploading',
      status_backup_start: 'Starting backup...',
      status_backup_done: 'Backup complete.',
      status_backup_empty: 'No chats found.',
      status_backup_failed: 'Backup failed.',
      status_chat_deleted: 'Chat deleted.',
      status_all_cleared: 'All chats cleared.',
      status_location_error: 'Unable to retrieve location. Allow permissions.',
      status_send_failed: 'Send failed. Retrying.',
      confirm_clear_all: 'Delete all chat history from this device?',
      confirm_delete_chat: 'Delete chat with {name}?',
      confirm_delete_current: 'Delete the current conversation?',
      confirm_yes: 'Yes',
      confirm_no: 'No',
      network_online: 'Online',
      network_offline: 'Offline',
      delete_for_me: 'Delete for me',
      delete_for_everyone: 'Delete for everyone',
      delete_close: 'Close',
      toast_info: 'Info',
      toast_error: 'Error',
      toast_success: 'Success',
      bot_welcome: 'Hello! You selected {category}. To get started, enter your ID:',
      bot_first_name: 'Thanks. What is your first name?',
      bot_last_name: 'Great. What is your last name?',
      bot_phone: 'Finally, what is your phone number?',
      bot_loading_departments: 'Searching for departments...',
      bot_select_department: 'Select a department by number:',
      bot_invalid_number: 'Invalid number. Try again.',
      bot_loading_actions: 'Loading topics...',
      bot_select_action: 'Select the relevant topic:',
      bot_registering: 'Thanks! Submitting your request...',
      bot_no_actions: 'No specific topics found. Submitting a general request.',
      bot_error_departments: 'Error loading departments. Try again later.',
      bot_error_actions: 'Error loading topics.',
      bot_support_logged: 'Your support request is logged and notifications are enabled.',
      bot_support_error: 'Connection error; we will try to process your request.'
    }
  };

  let currentLang = DEFAULT_LANG;

  const interpolate = (text, vars = {}) =>
    text.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? vars[key] : `{${key}}`));

  const t = (key, vars) => {
    const dict = translations[currentLang] || translations.he;
    const fallback = translations.he;
    const phrase = dict[key] || fallback[key] || key;
    return interpolate(phrase, vars);
  };

  const setLanguage = (lang) => {
    if (translations[lang]) {
      currentLang = lang;
    }
  };

  window.I18N = {
    t,
    setLanguage,
    get language() {
      return currentLang;
    }
  };
})();
