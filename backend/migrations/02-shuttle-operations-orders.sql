-- Shuttle Operations Orders Table
-- Stores shuttle operation orders with sync status tracking to Google Sheets

CREATE TABLE IF NOT EXISTS `shuttle_operations_orders` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `employee` VARCHAR(255) NOT NULL,
  `date` VARCHAR(50) NOT NULL,
  `date_alt` VARCHAR(50) NOT NULL,
  `shift` VARCHAR(50) NOT NULL,
  `station` VARCHAR(255) NOT NULL,
  `status` VARCHAR(255) NOT NULL,
  `user_id` VARCHAR(100) NULL,
  `sync_status` ENUM('PENDING', 'PROCESSING', 'SYNCED', 'FAILED') DEFAULT 'PENDING',
  `retry_count` INT DEFAULT 0,
  `last_error` TEXT NULL,
  `synced_at` DATETIME NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_sync_status` (`sync_status`, `retry_count`),
  INDEX `idx_created_at` (`created_at`),
  INDEX `idx_date` (`date`),
  INDEX `idx_employee` (`employee`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
