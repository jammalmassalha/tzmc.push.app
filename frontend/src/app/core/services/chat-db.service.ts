import Dexie, { type Table } from 'dexie';
import type { ChatGroup, ChatMessage, Contact } from '../models/chat.models';

/* ------------------------------------------------------------------ */
/*  IndexedDB schema managed by Dexie.js                              */
/*  Stores chat messages individually so that only changed rows are   */
/*  written, avoiding the large JSON.stringify that the old           */
/*  localStorage approach required.                                    */
/* ------------------------------------------------------------------ */

/** Row stored in the `messages` table. */
export interface PersistedMessage extends ChatMessage {
  /** Compound key: `${user}:${messageId}` */
  _pk: string;
  /** Owner of this cache row (normalised username). */
  _user: string;
}

/** Row stored in the `meta` table – one row per user. */
export interface PersistedMeta {
  /** Primary key = normalised username. */
  user: string;
  contacts: Contact[];
  groups: ChatGroup[];
  unreadByChat: Record<string, number>;
}

const DB_NAME = 'tzmc-chat';

export class ChatDatabase extends Dexie {
  messages!: Table<PersistedMessage, string>;
  meta!: Table<PersistedMeta, string>;

  constructor() {
    super(DB_NAME);

    this.version(1).stores({
      // _pk is the primary key; _user for range queries
      messages: '_pk, _user',
      meta: 'user'
    });
  }
}

/** Singleton database instance. */
let _db: ChatDatabase | null = null;

function getDb(): ChatDatabase {
  if (!_db) {
    _db = new ChatDatabase();
  }
  return _db;
}

/* ------------------------------------------------------------------ */
/*  Public helpers consumed by ChatStoreService                       */
/* ------------------------------------------------------------------ */

function messagePk(user: string, messageId: string): string {
  return `${user}:${messageId}`;
}

/** Persist the full state (contacts, groups, unread, messages) to IndexedDB.
 *  Messages are bulk-put individually so only changed rows trigger writes. */
export async function persistToIdb(
  user: string,
  contacts: Contact[],
  groups: ChatGroup[],
  unreadByChat: Record<string, number>,
  messages: ChatMessage[],
  maxMessages: number
): Promise<void> {
  const db = getDb();

  // Trim to the most recent N messages.
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const tail = sorted.slice(-maxMessages);

  const rows: PersistedMessage[] = tail.map((m) => ({
    ...m,
    _pk: messagePk(user, m.messageId),
    _user: user
  }));

  // Write meta (contacts, groups, unread) and messages in a single transaction.
  await db.transaction('rw', [db.meta, db.messages], async () => {
    await db.meta.put({ user, contacts, groups, unreadByChat });

    // Delete old messages for user that are no longer in the tail set,
    // then bulk-put the current set.
    const tailKeys = new Set(rows.map((r) => r._pk));
    const existingKeys = await db.messages.where('_user').equals(user).primaryKeys();
    const toDelete = existingKeys.filter((k) => !tailKeys.has(k as string));
    if (toDelete.length > 0) {
      await db.messages.bulkDelete(toDelete as string[]);
    }
    await db.messages.bulkPut(rows);
  });
}

/** Restore the full state from IndexedDB. Returns null if nothing is stored. */
export async function restoreFromIdb(
  user: string
): Promise<{
  contacts: Contact[];
  groups: ChatGroup[];
  unreadByChat: Record<string, number>;
  messages: ChatMessage[];
} | null> {
  const db = getDb();

  const metaRow = await db.meta.get(user);
  if (!metaRow) return null;

  const msgRows = await db.messages.where('_user').equals(user).toArray();

  // Strip internal keys before returning.
  const messages: ChatMessage[] = msgRows.map(({ _pk, _user, ...rest }) => rest as ChatMessage);

  return {
    contacts: metaRow.contacts,
    groups: metaRow.groups,
    unreadByChat: metaRow.unreadByChat,
    messages
  };
}

/** Delete all IndexedDB data for a given user. */
export async function clearIdbForUser(user: string): Promise<void> {
  const db = getDb();
  await db.transaction('rw', [db.meta, db.messages], async () => {
    await db.meta.delete(user);
    await db.messages.where('_user').equals(user).delete();
  });
}

/* ------------------------------------------------------------------ */
/*  Migration: one-time import from localStorage into IndexedDB.      */
/* ------------------------------------------------------------------ */

const IDB_MIGRATION_KEY = 'tzmc-idb-migration-v1';

/** Returns true if there is a localStorage state that should be migrated. */
export function needsIdbMigration(): boolean {
  try {
    return !localStorage.getItem(IDB_MIGRATION_KEY);
  } catch {
    return false;
  }
}

/** Mark migration as complete so we don't repeat it. */
export function markIdbMigrationDone(): void {
  try {
    localStorage.setItem(IDB_MIGRATION_KEY, '1');
  } catch {
    // best-effort
  }
}
