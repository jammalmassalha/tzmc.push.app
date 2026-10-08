-- Shuttle Orders Table - Transactional Outbox Pattern
-- Stores shuttle booking requests with sync status tracking to Google Sheets

CREATE TABLE IF NOT EXISTS `shuttle_orders` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` VARCHAR(100) NULL,
  `user_name` VARCHAR(255) NULL,
  `phone` VARCHAR(50) NULL,
  `pickup_location` VARCHAR(255) NOT NULL,
  `dropoff_location` VARCHAR(255) NOT NULL,
  `pickup_time` DATETIME NOT NULL,
  `passengers_count` INT DEFAULT 1,
  `notes` TEXT NULL,
  `raw_payload` JSON NULL,
  `sync_status` ENUM('PENDING', 'PROCESSING', 'SYNCED', 'FAILED') DEFAULT 'PENDING',
  `retry_count` INT DEFAULT 0,
  `last_error` TEXT NULL,
  `synced_at` DATETIME NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_sync_status` (`sync_status`, `retry_count`),
  INDEX `idx_created_at` (`created_at`),
  INDEX `idx_pickup_time` (`pickup_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
