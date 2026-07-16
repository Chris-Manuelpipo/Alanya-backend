
-- =============================================================
--  1. PAYS (référentiel pays / fuseaux)
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
  alanyaID         INT          NOT NULL AUTO_INCREMENT,
  nom              VARCHAR(60)  NOT NULL,
  pseudo           VARCHAR(80)  NOT NULL DEFAULT 'alanyaUser',
  alanyaPhone      VARCHAR(20)  NOT NULL,
  idPays           SMALLINT     NOT NULL,
  password         VARCHAR(255) NOT NULL,
  avatar_url       VARCHAR(255) NOT NULL DEFAULT 'NON DEFINI',
  type_compte      SMALLINT     NULL     DEFAULT 0,
  is_online        TINYINT      NOT NULL DEFAULT 0,
  last_seen        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exclus           TINYINT      NOT NULL DEFAULT 0,
  exclude_at       DATETIME     NULL,
  exclude_reason   VARCHAR(255) NULL,
  in_call          TINYINT      NOT NULL DEFAULT 0,
  biometric        TINYINT      NOT NULL DEFAULT 0,
  fcm_token        VARCHAR(255) NOT NULL DEFAULT 'INDEFINI',
  device_ID        VARCHAR(255) NOT NULL DEFAULT 'INDEFINI' COMMENT 'Android ID ou Apple ID',
  email            VARCHAR(255) NULL COMMENT 'Email pour authentication et reset password',
  reset_otp        VARCHAR(6)   NULL COMMENT 'OTP de 6 chiffres pour reset password',
  reset_otp_expires_at DATETIME NULL COMMENT 'Expiration de l''OTP (10 minutes)',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alanyaID),
  UNIQUE KEY uq_phone (alanyaPhone),
  UNIQUE KEY uq_email (email),
  KEY idx_users_phone (alanyaPhone),
  KEY idx_users_online (is_online, last_seen),
  KEY idx_users_created_at (created_at),
  KEY idx_users_type_compte (type_compte),
  KEY idx_users_exclus (exclus),
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
  KEY idx_useraccess_datelogin (dateLogin),
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
  KEY idx_cp_user_conv (alanyaID, conversID),
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
  clientID       VARCHAR(64)  NULL COMMENT 'Idempotence client (UUID) — existe en prod, indexé en 015',
  content        TEXT         NULL,
  type           SMALLINT     NULL     DEFAULT 0  COMMENT '0=text 1=image 2=video 3=audio 4=file 5=location',
  status         TINYINT      NOT NULL DEFAULT 0  COMMENT '0=sending 1=sent 2=delivered 3=read',
  sendAt         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clickSentAt    DATETIME     NULL COMMENT 'Instant (horloge expéditeur) où il a appuyé sur Envoyer',
  readAt         DATETIME     NULL,
  mediaUrl       VARCHAR(255) NULL,
  mediaName      VARCHAR(255) NULL,
  mediaDuration  INT          NULL     DEFAULT 0  COMMENT 'Durée en secondes (audio/vidéo)',
  mediaThumb     MEDIUMTEXT   NULL COMMENT 'Vignette vidéo (JPEG base64) pour aperçu destinataire',
  isDeleted      TINYINT      NOT NULL DEFAULT 0,
  deletedForID   INT          NULL               COMMENT 'NULL=visible tous | id=supprimé pour cet user uniquement',
  isEdited       TINYINT      NOT NULL DEFAULT 0,
  editedAt       DATETIME     NULL,
  replyToID      BIGINT       NULL,
  replyToContent TEXT         NULL,
  isStatusReply  TINYINT      NOT NULL DEFAULT 0,
  isForwarded    TINYINT      NOT NULL DEFAULT 0  COMMENT '1 = message transféré',
  isPinned       TINYINT      NOT NULL DEFAULT 0  COMMENT '1 = message épinglé',
  pinnedAt       DATETIME     NULL                COMMENT 'Date du dernier épinglage',
  pinnedBy       INT          NULL                COMMENT 'alanyaID de l''auteur de l''épinglage',
  isViewOnce     TINYINT      NOT NULL DEFAULT 0  COMMENT '1 = média à vue unique',
  viewedAt       DATETIME     NULL                COMMENT 'Média vue unique consulté (1-1)',
  PRIMARY KEY (msgID),
  UNIQUE KEY uq_message_sender_client (senderID, clientID),
  KEY idx_message_conv_date (conversationID, sendAt DESC),
  KEY idx_message_sendat (sendAt),
  CONSTRAINT fk_msg_sender  FOREIGN KEY (senderID)       REFERENCES users(alanyaID)        ON UPDATE CASCADE,
  CONSTRAINT fk_msg_conv    FOREIGN KEY (conversationID) REFERENCES conversation(conversID) ON DELETE CASCADE,
  CONSTRAINT fk_msg_reply   FOREIGN KEY (replyToID)      REFERENCES message(msgID)          ON DELETE SET NULL,
  CONSTRAINT fk_msg_del_for FOREIGN KEY (deletedForID)   REFERENCES users(alanyaID)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  9. STATUT (Stories 24h)
-- =============================================================
CREATE TABLE IF NOT EXISTS statut (
  ID              INT          NOT NULL AUTO_INCREMENT,
  alanyaID        INT          NOT NULL,
  type            SMALLINT     NOT NULL             COMMENT '0=text 1=image 2=video 3=audio',
  text            TINYTEXT     NOT NULL,
  mediaUrl        VARCHAR(255) NULL,
  mediaDurationMs INT          NULL COMMENT 'Durée média en millisecondes',
  backgroundColor VARCHAR(20)  NULL,
  createdAt       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiredAt       DATETIME     NOT NULL,
  viewedBy        INT          NOT NULL DEFAULT 0   COMMENT 'Compteur dénormalisé',
  likedBy         INT          NOT NULL DEFAULT 0   COMMENT 'Compteur dénormalisé',
  PRIMARY KEY (ID),
  KEY idx_statut_user_exp (alanyaID, expiredAt),
  KEY idx_statut_createdat (createdAt),
  CONSTRAINT fk_statut_user FOREIGN KEY (alanyaID) REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  10. STATUT_VIEWS (vues / likes)
-- =============================================================
CREATE TABLE IF NOT EXISTS statut_views (
  id       BIGINT   NOT NULL AUTO_INCREMENT,
  statutID INT      NOT NULL,
  alanyaID INT      NOT NULL,
  seenAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  liked    TINYINT(1) NOT NULL DEFAULT 0,
  likedAt  DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_statut_viewer (statutID, alanyaID),
  KEY idx_sv_statut_liked (statutID, liked),
  CONSTRAINT fk_sv_statut FOREIGN KEY (statutID) REFERENCES statut(ID)      ON DELETE CASCADE,
  CONSTRAINT fk_sv_user   FOREIGN KEY (alanyaID) REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  11. MEETING (réunions / appels de groupe)
-- =============================================================
CREATE TABLE IF NOT EXISTS meeting (
  idMeeting     INT          NOT NULL AUTO_INCREMENT,
  idOrganiser   INT          NOT NULL,
  start_time    DATETIME     NOT NULL,
  duree         INT          NOT NULL DEFAULT 0,
  objet         VARCHAR(255) NOT NULL DEFAULT 'NON DEFINI',
  room          VARCHAR(100) NOT NULL,
  isEnd         TINYINT      NOT NULL DEFAULT 0,
  type_media    TINYINT      NOT NULL DEFAULT 0  COMMENT '0=audio 1=video',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reminder_sent TINYINT      NOT NULL DEFAULT 0  COMMENT '0=rappel non envoyé | 1=envoyé',
  PRIMARY KEY (idMeeting),
  KEY idx_reminder_sent (reminder_sent, isEnd),
  CONSTRAINT fk_meeting_organiser FOREIGN KEY (idOrganiser) REFERENCES users(alanyaID) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  12. PARTICIPANT (membres d'une réunion)
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
  CONSTRAINT fk_part_meeting FOREIGN KEY (idMeeting)     REFERENCES meeting(idMeeting) ON DELETE CASCADE,
  CONSTRAINT fk_part_user    FOREIGN KEY (IDparticipant) REFERENCES users(alanyaID)    ON UPDATE CASCADE
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
  mode       TINYINT  NULL     DEFAULT NULL COMMENT '0=relay/TURN 1=P2P(host+srflx) NULL=inconnu',
  ip         VARCHAR(45) NULL  DEFAULT NULL COMMENT 'IP appelant au moment de call_user',
  PRIMARY KEY (IDcall),
  KEY idx_caller (idCaller),
  KEY idx_receiver (idReceiver),
  KEY idx_created_at (created_at),
  KEY idx_call_caller_date (idCaller, created_at DESC),
  KEY idx_call_receiver_date (idReceiver, created_at DESC),
  CONSTRAINT fk_call_caller   FOREIGN KEY (idCaller)   REFERENCES users(alanyaID) ON UPDATE CASCADE,
  CONSTRAINT fk_call_receiver FOREIGN KEY (idReceiver) REFERENCES users(alanyaID) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================
--  14. RESERVED_ALANYA_PHONE (numéros réservés admin)
-- =============================================================
CREATE TABLE IF NOT EXISTS reserved_alanya_phone (
  id              INT          NOT NULL AUTO_INCREMENT,
  phone_canonical VARCHAR(8)   NOT NULL,
  label           VARCHAR(100) NOT NULL,
  created_by      INT          NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reserved_phone (phone_canonical),
  CONSTRAINT fk_reserved_created_by FOREIGN KEY (created_by) REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


