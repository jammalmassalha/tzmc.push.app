import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface ToSendMessage {
  id?: number;
  recipient: string;
  sender: string;
  message_content: string;
  created_at?: Date | string;
  status?: string;
}

export interface ToSendMessageResponse {
  recipient: string;
  sender: string;
  content: string;
}

export class ToSendQueueService {
  private pool: Pool;
  private tableReady = false;
  private readonly tableName = '`ToSendQueue`';

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Ensure the ToSendQueue table exists
   */
  async ensureTableExists(): Promise<void> {
    if (this.tableReady) return;
    try {
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          \`Id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`Recipient\` VARCHAR(50) NOT NULL,
          \`Sender\` VARCHAR(255) NOT NULL,
          \`MessageContent\` LONGTEXT NOT NULL,
          \`CreatedAt\` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
          \`Status\` VARCHAR(20) DEFAULT 'pending',
          PRIMARY KEY (\`Id\`),
          INDEX \`idx_tosend_recipient\` (\`Recipient\`),
          INDEX \`idx_tosend_status\` (\`Status\`),
          INDEX \`idx_tosend_created_at\` (\`CreatedAt\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      this.tableReady = true;
      console.log('[TOSEND] ToSendQueue table ensured.');
    } catch (err: unknown) {
      const message = String((err as { message?: string }).message || '');
      console.warn('[TOSEND] ensureTableExists warning:', message);
    }
  }

  /**
   * Add a message to the queue
   */
  async addMessage(message: ToSendMessage): Promise<number> {
    await this.ensureTableExists();
    
    const sql = `
      INSERT INTO ${this.tableName} (\`Recipient\`, \`Sender\`, \`MessageContent\`, \`Status\`)
      VALUES (?, ?, ?, 'pending')
    `;
    
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        sql,
        [message.recipient, message.sender, message.message_content]
      );
      return result.insertId;
    } catch (err: unknown) {
      const errorMessage = String((err as { message?: string }).message || '');
      console.error('[TOSEND] addMessage error:', errorMessage);
      throw err;
    }
  }

  /**
   * Add multiple messages to the queue (bulk insert)
   */
  async addMessages(messages: ToSendMessage[]): Promise<number> {
    await this.ensureTableExists();
    
    if (!messages || messages.length === 0) {
      return 0;
    }

    const placeholders = messages.map(() => '(?, ?, ?, "pending")').join(',');
    const values = messages.flatMap(m => [m.recipient, m.sender, m.message_content]);
    
    const sql = `
      INSERT INTO ${this.tableName} (\`Recipient\`, \`Sender\`, \`MessageContent\`, \`Status\`)
      VALUES ${placeholders}
    `;
    
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(sql, values);
      return result.affectedRows;
    } catch (err: unknown) {
      const errorMessage = String((err as { message?: string }).message || '');
      console.error('[TOSEND] addMessages error:', errorMessage);
      throw err;
    }
  }

  /**
   * Get pending messages, optionally filtered by recipient
   * Deduplicates identical messages and marks them as retrieved
   */
  async getPendingMessages(recipient?: string): Promise<ToSendMessageResponse[]> {
    await this.ensureTableExists();
    
    let sql = `
      SELECT \`Id\`, \`Recipient\`, \`Sender\`, \`MessageContent\`
      FROM ${this.tableName}
      WHERE \`Status\` = 'pending'
    `;
    const params: any[] = [];

    if (recipient) {
      sql += ` AND \`Recipient\` = ?`;
      params.push(recipient);
    }

    sql += ` ORDER BY \`CreatedAt\` ASC`;

    try {
      const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);
      
      // Deduplicate identical messages within the batch
      const seenKeys = new Set<string>();
      const messages: ToSendMessageResponse[] = [];
      const rowsToMarkSent: number[] = [];

      for (const row of rows) {
        const rowId = (row as any).Id;
        const recip = String(row.Recipient || '').trim();
        const sender = String(row.Sender || '').trim();
        const content = String(row.MessageContent || '').trim();
        
        // Create dedup key: lowercase normalized version
        const dedupKey = `${recip.toLowerCase()}|${sender.toLowerCase()}|${content.replace(/\s+/g, ' ').toLowerCase()}`;
        
        if (!seenKeys.has(dedupKey)) {
          seenKeys.add(dedupKey);
          messages.push({
            recipient: recip,
            sender: sender,
            content: content
          });
        }
        
        // Mark all rows (including duplicates) as sent so they're removed from queue
        rowsToMarkSent.push(rowId);
      }

      // Mark all processed rows as sent (will be deleted next)
      if (rowsToMarkSent.length > 0) {
        await this.markMessagesSent(rowsToMarkSent);
      }

      return messages;
    } catch (err: unknown) {
      const errorMessage = String((err as { message?: string }).message || '');
      console.error('[TOSEND] getPendingMessages error:', errorMessage);
      throw err;
    }
  }

  /**
   * Mark messages as sent (update status)
   */
  async markMessagesSent(ids: number[]): Promise<void> {
    if (!ids || ids.length === 0) return;

    await this.ensureTableExists();
    
    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      UPDATE ${this.tableName}
      SET \`Status\` = 'sent'
      WHERE \`Id\` IN (${placeholders})
    `;

    try {
      await this.pool.execute(sql, ids);
    } catch (err: unknown) {
      const errorMessage = String((err as { message?: string }).message || '');
      console.error('[TOSEND] markMessagesSent error:', errorMessage);
      throw err;
    }
  }

  /**
   * Delete sent messages (cleanup)
   */
  async deleteSentMessages(): Promise<number> {
    await this.ensureTableExists();
    
    const sql = `
      DELETE FROM ${this.tableName}
      WHERE \`Status\` = 'sent'
    `;

    try {
      const [result] = await this.pool.execute<ResultSetHeader>(sql);
      return result.affectedRows;
    } catch (err: unknown) {
      const errorMessage = String((err as { message?: string }).message || '');
      console.error('[TOSEND] deleteSentMessages error:', errorMessage);
      throw err;
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{ pending: number; sent: number; total: number }> {
    await this.ensureTableExists();
    
    const sql = `
      SELECT 
        SUM(CASE WHEN \`Status\` = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN \`Status\` = 'sent' THEN 1 ELSE 0 END) as sent,
        COUNT(*) as total
      FROM ${this.tableName}
    `;

    try {
      const [rows] = await this.pool.execute<RowDataPacket[]>(sql);
      const row = rows[0] as any;
      return {
        pending: row.pending || 0,
        sent: row.sent || 0,
        total: row.total || 0
      };
    } catch (err: unknown) {
      const errorMessage = String((err as { message?: string }).message || '');
      console.error('[TOSEND] getQueueStats error:', errorMessage);
      return { pending: 0, sent: 0, total: 0 };
    }
  }

  /**
   * Clear all messages from queue
   */
  async clearQueue(): Promise<number> {
    await this.ensureTableExists();
    
    const sql = `TRUNCATE TABLE ${this.tableName}`;

    try {
      const [result] = await this.pool.execute<ResultSetHeader>(sql);
      return result.affectedRows;
    } catch (err: unknown) {
      const errorMessage = String((err as { message?: string }).message || '');
      console.error('[TOSEND] clearQueue error:', errorMessage);
      throw err;
    }
  }
}
