-- =============================================================
--  TALKY — Script SQL Initial
--  MySQL 8.0+
--  Migration 001: Création des tables de base
-- =============================================================

-- Création de la base de données
CREATE DATABASE IF NOT EXISTS talky
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE talky;

-- =============================================================
--  1. PAYS (référentiel)
-- =============================================================
CREATE TABLE IF NOT EXISTS pays (
  idPays          SMALLINT     NOT NULL AUTO_INCREMENT,
  libelle         VARCHAR(100) NOT NULL,
  prefix          VARCHAR(4)   NOT NULL,
  timeZone        VARCHAR(100) NULL,
  decalageHoraire INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (idPays)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  2. USERS
-- =============================================================
CREATE TABLE IF NOT EXISTS users (
  alanyaID    INT          NOT NULL AUTO_INCREMENT,
  nom         VARCHAR(60)  NOT NULL,
  pseudo      VARCHAR(80)  NOT NULL DEFAULT 'alanyaUser',
  alanyaPhone VARCHAR(20)  NOT NULL,
  idPays      SMALLINT     NOT NULL,
  password    VARCHAR(255) NOT NULL,
  avatar_url  VARCHAR(255) NOT NULL DEFAULT 'NON DEFINI',
  type_compte SMALLINT     NULL     DEFAULT 0,
  is_online   TINYINT      NOT NULL DEFAULT 0,
  last_seen   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exclus      TINYINT      NOT NULL DEFAULT 0,
  in_call     TINYINT      NOT NULL DEFAULT 0,
  biometric   TINYINT      NOT NULL DEFAULT 0,
  fcm_token   VARCHAR(255) NOT NULL DEFAULT 'INDEFINI',
  device_ID   VARCHAR(255) NOT NULL DEFAULT 'INDEFINI' COMMENT 'Android ID ou Apple ID',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alanyaID),
  UNIQUE KEY uq_phone (alanyaPhone),
  CONSTRAINT fk_users_pays FOREIGN KEY (idPays) REFERENCES pays(idPays) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  3. PREFERRED_CONTACT (contacts / amis)
-- =============================================================
CREATE TABLE IF NOT EXISTS preferredContact (
  idPrefContact BIGINT   NOT NULL AUTO_INCREMENT,
  alanyaID      INT      NOT NULL,
  idFriend      INT      NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (idPrefContact),
  UNIQUE KEY uq_friendship (alanyaID, idFriend),
  CONSTRAINT fk_pref_owner  FOREIGN KEY (alanyaID) REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_pref_friend FOREIGN KEY (idFriend) REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  4. BLOCKED
-- =============================================================
CREATE TABLE IF NOT EXISTS blocked (
  idBlock       INT      NOT NULL AUTO_INCREMENT,
  alanyaID      INT      NOT NULL,
  idCallerBlock INT      NOT NULL,
  dateBlock     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (idBlock),
  UNIQUE KEY uq_block (alanyaID, idCallerBlock),
  CONSTRAINT fk_block_owner  FOREIGN KEY (alanyaID)      REFERENCES users(alanyaID) ON UPDATE CASCADE,
  CONSTRAINT fk_block_target FOREIGN KEY (idCallerBlock) REFERENCES users(alanyaID) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  5. USER_ACCESS (journal de connexions)
-- =============================================================
CREATE TABLE IF NOT EXISTS userAccess (
  idLogin    BIGINT       NOT NULL AUTO_INCREMENT,
  alanyaID   INT          NOT NULL,
  device     VARCHAR(255) NOT NULL DEFAULT 'INDEFINI',
  dateLogin  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ipAdress   VARCHAR(255) NOT NULL DEFAULT 'INDEFINI',
  os_system  VARCHAR(255) NOT NULL DEFAULT 'INDEFINI',
  PRIMARY KEY (idLogin),
  CONSTRAINT fk_access_user FOREIGN KEY (alanyaID) REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  6. CONVERSATION
-- =============================================================
CREATE TABLE IF NOT EXISTS conversation (
  conversID             BIGINT       NOT NULL AUTO_INCREMENT,
  isGroup               TINYINT      NOT NULL DEFAULT 0,
  GroupName             VARCHAR(255) NULL,
  groupPhoto            VARCHAR(255) NULL,
  lastMessage           TEXT         NULL,
  lastMessageAt         DATETIME     NULL,
  lastMessageSenderID   INT          NULL,
  lastMessageType       SMALLINT     NOT NULL DEFAULT 0  COMMENT '0=text 1=image 2=video 3=audio 4=file',
  lastMessageStatus     TINYINT      NOT NULL DEFAULT 0  COMMENT '0=sent 1=delivered 2=read',
  PRIMARY KEY (conversID),
  CONSTRAINT fk_conv_last_sender FOREIGN KEY (lastMessageSenderID) REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  7. CONV_PARTICIPANTS (jointure conversation ↔ users)
-- =============================================================
CREATE TABLE IF NOT EXISTS conv_participants (
  id          BIGINT   NOT NULL AUTO_INCREMENT,
  conversID   BIGINT   NOT NULL,
  alanyaID    INT      NOT NULL,
  unreadCount SMALLINT NOT NULL DEFAULT 0,
  isPinned    TINYINT  NOT NULL DEFAULT 0,
  isArchived  TINYINT  NOT NULL DEFAULT 0,
  joinedAt    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_conv_user (conversID, alanyaID),
  CONSTRAINT fk_cp_conv FOREIGN KEY (conversID) REFERENCES conversation(conversID) ON DELETE CASCADE,
  CONSTRAINT fk_cp_user FOREIGN KEY (alanyaID)  REFERENCES users(alanyaID)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  8. MESSAGE
-- =============================================================
CREATE TABLE IF NOT EXISTS message (
  msgID          BIGINT       NOT NULL AUTO_INCREMENT,
  senderID       INT          NOT NULL,
  conversationID BIGINT       NOT NULL,
  content        TEXT         NULL,
  type           SMALLINT     NULL     DEFAULT 0  COMMENT '0=text 1=image 2=video 3=audio 4=file 5=location',
  status         TINYINT      NOT NULL DEFAULT 0  COMMENT '0=sending 1=sent 2=delivered 3=read',
  sendAt         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  readAt         DATETIME     NULL,
  mediaUrl       VARCHAR(255) NULL,
  mediaName      VARCHAR(255) NULL,
  mediaDuration  INT          NULL     DEFAULT 0  COMMENT 'Durée en secondes (audio/vidéo)',
  isDeleted      TINYINT      NOT NULL DEFAULT 0,
  deletedForID   INT          NULL               COMMENT 'NULL=visible tous | id=supprimé pour cet user uniquement',
  isEdited       TINYINT      NOT NULL DEFAULT 0,
  editedAt       DATETIME     NULL,
  replyToID      BIGINT       NULL,
  replyToContent TEXT         NULL,
  isStatusReply  TINYINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (msgID),
  CONSTRAINT fk_msg_sender    FOREIGN KEY (senderID)       REFERENCES users(alanyaID)        ON UPDATE CASCADE,
  CONSTRAINT fk_msg_conv      FOREIGN KEY (conversationID) REFERENCES conversation(conversID) ON DELETE CASCADE,
  CONSTRAINT fk_msg_reply     FOREIGN KEY (replyToID)      REFERENCES message(msgID)          ON DELETE SET NULL,
  CONSTRAINT fk_msg_del_for   FOREIGN KEY (deletedForID)   REFERENCES users(alanyaID)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  9. STATUT (Stories 24h)
-- =============================================================
CREATE TABLE IF NOT EXISTS statut (
  ID              INT          NOT NULL AUTO_INCREMENT,
  alanyaID        INT          NOT NULL,
  type            SMALLINT     NOT NULL             COMMENT '0=text 1=image 2=video',
  text            TINYTEXT     NOT NULL,
  mediaUrl        VARCHAR(255) NULL,
  backgroundColor VARCHAR(20)  NULL,
  createdAt       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiredAt       DATETIME     NOT NULL,
  viewedBy        INT          NOT NULL DEFAULT 0   COMMENT 'Compteur dénormalisé',
  likedBy         INT          NOT NULL DEFAULT 0   COMMENT 'Compteur dénormalisé',
  PRIMARY KEY (ID),
  CONSTRAINT fk_statut_user FOREIGN KEY (alanyaID) REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  10. STATUT_VIEWS (détail des vues — qui a vu quand)
-- =============================================================
CREATE TABLE IF NOT EXISTS statut_views (
  id       BIGINT   NOT NULL AUTO_INCREMENT,
  statutID INT      NOT NULL,
  alanyaID INT      NOT NULL,
  seenAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_statut_viewer (statutID, alanyaID),
  CONSTRAINT fk_sv_statut FOREIGN KEY (statutID) REFERENCES statut(ID)           ON DELETE CASCADE,
  CONSTRAINT fk_sv_user   FOREIGN KEY (alanyaID) REFERENCES users(alanyaID)      ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  11. MEETING (appels de groupe / réunions)
-- =============================================================
CREATE TABLE IF NOT EXISTS meeting (
  idMeeting   INT          NOT NULL AUTO_INCREMENT,
  idOrganiser INT          NOT NULL,
  start_time  DATETIME     NOT NULL,
  duree       INT          NOT NULL DEFAULT 0,
  objet       VARCHAR(255) NOT NULL DEFAULT 'NON DEFINI',
  room        VARCHAR(100) NOT NULL,
  isEnd       TINYINT      NOT NULL DEFAULT 0,
  type_media  TINYINT      NOT NULL DEFAULT 0  COMMENT '0=audio 1=video',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (idMeeting),
  CONSTRAINT fk_meeting_organiser FOREIGN KEY (idOrganiser) REFERENCES users(alanyaID) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  12. PARTICIPANT (membres d'une réunion/appel groupe)
-- =============================================================
CREATE TABLE IF NOT EXISTS participant (
  ID            INT      NOT NULL AUTO_INCREMENT,
  idMeeting     INT      NOT NULL,
  IDparticipant INT      NOT NULL,
  status        TINYINT  NOT NULL DEFAULT 0  COMMENT '0=invité 1=accepté 2=refusé',
  start_time    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  connecte      TINYINT  NULL,
  duree         INT      NOT NULL DEFAULT 0,
  PRIMARY KEY (ID),
  UNIQUE KEY uq_meeting_user (idMeeting, IDparticipant),
  CONSTRAINT fk_part_meeting FOREIGN KEY (idMeeting)     REFERENCES meeting(idMeeting)    ON DELETE CASCADE,
  CONSTRAINT fk_part_user    FOREIGN KEY (IDparticipant) REFERENCES users(alanyaID)        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  13. CALL_HISTORY (appels 1-à-1)
-- =============================================================
CREATE TABLE IF NOT EXISTS callHistory (
  IDcall     BIGINT   NOT NULL AUTO_INCREMENT,
  idCaller   INT      NOT NULL,
  idReceiver INT      NOT NULL,
  type       SMALLINT NOT NULL DEFAULT 0  COMMENT '0=audio 1=video',
  status     SMALLINT NOT NULL DEFAULT 0  COMMENT '0=missed 1=answered 2=rejected',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  start_time DATETIME NULL     DEFAULT NULL,
  duree      INT      NOT NULL DEFAULT 0  COMMENT 'Durée en secondes',
  PRIMARY KEY (IDcall),
  CONSTRAINT fk_call_caller   FOREIGN KEY (idCaller)   REFERENCES users(alanyaID) ON UPDATE CASCADE,
  CONSTRAINT fk_call_receiver FOREIGN KEY (idReceiver) REFERENCES users(alanyaID) ON UPDATE CASCADE,
  INDEX idx_caller (idCaller),
  INDEX idx_receiver (idReceiver),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  INDEX DE PERFORMANCE
-- =============================================================
CREATE INDEX idx_message_conv_date    ON message(conversationID, sendAt DESC);
CREATE INDEX idx_cp_user_conv         ON conv_participants(alanyaID, conversID);
CREATE INDEX idx_statut_user_exp      ON statut(alanyaID, expiredAt);
CREATE INDEX idx_call_caller_date     ON callHistory(idCaller,   created_at DESC);
CREATE INDEX idx_call_receiver_date   ON callHistory(idReceiver, created_at DESC);
CREATE INDEX idx_users_phone          ON users(alanyaPhone);
CREATE INDEX idx_users_online         ON users(is_online, last_seen);
