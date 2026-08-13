-- Migration 039 : file de jobs + leases schedulers singleton

CREATE TABLE IF NOT EXISTS job_queue (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  kind         VARCHAR(40)  NOT NULL,
  payload      JSON         NOT NULL,
  dedupe_key   VARCHAR(128) NULL,
  run_after    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts     TINYINT      NOT NULL DEFAULT 0,
  max_attempts TINYINT      NOT NULL DEFAULT 5,
  locked_at    DATETIME     NULL,
  locked_by    VARCHAR(128) NULL,
  failed_at    DATETIME     NULL,
  last_error   TEXT         NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_dedupe (kind, dedupe_key),
  KEY idx_job_pret (kind, failed_at, locked_at, run_after)
);

CREATE TABLE IF NOT EXISTS scheduler_leases (
  name         VARCHAR(64)  NOT NULL PRIMARY KEY,
  locked_by    VARCHAR(128) NULL,
  locked_until DATETIME     NULL
);

INSERT IGNORE INTO scheduler_leases (name) VALUES
  ('meeting_scheduler'),
  ('verification_scheduler'),
  ('broadcast_nightly_purge'),
  ('broadcast_scheduled_tick');
