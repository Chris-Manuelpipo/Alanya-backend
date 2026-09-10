-- Migration 080 : abonnement Alanya Plus — catalogue, périodes, paiements, réglage global
--
-- Volet 8 de la conception (docs/architecture/abonnement.pdf, dépôt de l'app).
-- Appliquer après 079. Application manuelle ; réexécutable sans erreur :
-- CREATE TABLE IF NOT EXISTS et INSERT IGNORE partout.
--
-- ── Ce que ces tables séparent ──
--
-- L'identité (le dossier de vérification, migration 081) et l'argent (ici)
-- vivent dans des tables distinctes. La coche indigo se DÉDUIT des deux ; les
-- fonctionnalités payantes se déduisent de l'abonnement seul. Aucune
-- fonctionnalité ne s'ouvre par la coche.
--
-- ── Une ligne par période payée ──
--
-- `subscription_period` n'est jamais modifiée, seulement ajoutée. Être abonné,
-- c'est avoir une période qui couvre l'instant présent. Renouveler en avance,
-- changer de durée, offrir un mois, compenser un retour au gratuit : ce sont
-- des lignes de plus, sans machine à états à tenir.
--
-- ── Le catalogue est en base ──
--
-- Prix, durées, relances, contenu des plans et libellés se modifient depuis
-- l'administration. Les CODES de fonctionnalité, eux, sont connus du code :
-- c'est lui qui pose les verrous. L'administration peut rendre une
-- fonctionnalité payante ou gratuite, pas en inventer une.
--
-- ── Deux pièges déjà rencontrés sur ce schéma ──
--
-- `users.alanyaID` est un INT signé : toutes les clés étrangères qui le visent
-- le sont aussi (erreur 3780 sinon). Et le XAF n'a pas de sous-unité : 250 F
-- s'écrit 250, jamais 25000.

CREATE TABLE IF NOT EXISTS feature (
  code             VARCHAR(40) NOT NULL COMMENT 'Code connu du code applicatif',
  name_i18n        JSON        NOT NULL COMMENT '{"fr":…,"en":…,"zh":…}',
  description_i18n JSON        NULL,
  is_paid          TINYINT     NOT NULL DEFAULT 1
                     COMMENT '0 = gratuite pour tous, même en phase payante',
  is_available     TINYINT     NOT NULL DEFAULT 1
                     COMMENT '0 = annoncée, pas encore livrée par le code',
  sort_order       SMALLINT    NOT NULL DEFAULT 0,
  updated_at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS plan (
  id                    INT          NOT NULL AUTO_INCREMENT,
  code                  VARCHAR(40)  NOT NULL,
  name_i18n             JSON         NOT NULL,
  duration_months       TINYINT      NOT NULL COMMENT '1 = mensuel, 12 = annuel',
  price_amount          INT          NOT NULL
                          COMMENT 'Unités entières : le XAF n''a pas de sous-unité',
  currency              CHAR(3)      NOT NULL DEFAULT 'XAF',
  reminder_days         SMALLINT     NOT NULL COMMENT 'Relance avant échéance',
  is_active             TINYINT      NOT NULL DEFAULT 1 COMMENT '0 = retiré de l''offre',
  is_featured           TINYINT      NOT NULL DEFAULT 0 COMMENT 'Mis en avant dans l''offre',
  sort_order            SMALLINT     NOT NULL DEFAULT 0,
  store_product_ios     VARCHAR(100) NULL,
  store_product_android VARCHAR(100) NULL,
  updated_by            INT          NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plan_code (code),
  CONSTRAINT ck_plan_duration CHECK (duration_months BETWEEN 1 AND 36),
  CONSTRAINT ck_plan_price    CHECK (price_amount >= 0),
  CONSTRAINT ck_plan_reminder CHECK (reminder_days >= 0),
  CONSTRAINT fk_plan_updater FOREIGN KEY (updated_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS plan_feature (
  plan_id      INT         NOT NULL,
  feature_code VARCHAR(40) NOT NULL,
  PRIMARY KEY (plan_id, feature_code),
  CONSTRAINT fk_pf_plan    FOREIGN KEY (plan_id) REFERENCES plan(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_pf_feature FOREIGN KEY (feature_code) REFERENCES feature(code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Une seule ligne, garantie par la contrainte : c'est l'interrupteur du
-- payant. Il vit en base et non dans data/app-settings.json : un fichier local
-- diverge dès qu'il y a deux instances du serveur.
CREATE TABLE IF NOT EXISTS billing_settings (
  id                 TINYINT  NOT NULL DEFAULT 1,
  paid_enabled       TINYINT  NOT NULL DEFAULT 0,
  activated_at       DATETIME NULL,
  grace_until        DATETIME NULL,
  deactivated_at     DATETIME NULL,
  default_grace_days SMALLINT NOT NULL DEFAULT 30,
  trial_days         SMALLINT NOT NULL DEFAULT 0,
  retention_days     SMALLINT NOT NULL DEFAULT 30
                       COMMENT 'Conservation des données payantes après échéance',
  updated_by         INT      NULL,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT ck_billing_singleton CHECK (id = 1),
  -- Pas de passage au payant sans préavis : 7 jours de grâce au minimum.
  CONSTRAINT ck_billing_grace     CHECK (default_grace_days >= 7),
  CONSTRAINT ck_billing_trial     CHECK (trial_days >= 0),
  CONSTRAINT ck_billing_retention CHECK (retention_days >= 0),
  CONSTRAINT fk_billing_updater FOREIGN KEY (updated_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  alanyaID        INT          NOT NULL,
  plan_id         INT          NOT NULL,
  provider        VARCHAR(32)  NOT NULL
                    COMMENT 'simulated, <agrégateur>, apple, google, wallet',
  channel         VARCHAR(32)  NOT NULL
                    COMMENT 'orange_money, mtn_momo, store, wallet',
  msisdn          VARCHAR(20)  NULL,
  amount          INT          NOT NULL COMMENT 'Prix du plan AU MOMENT du paiement',
  currency        CHAR(3)      NOT NULL,
  purpose         TINYINT      NOT NULL DEFAULT 0
                    COMMENT '0=souscription 1=renouvellement 2=renouvellement auto',
  status          TINYINT      NOT NULL DEFAULT 0
                    COMMENT '0=créé 1=en attente 2=réussi 3=échoué 4=expiré 5=remboursé',
  idempotency_key VARCHAR(80)  NOT NULL,
  provider_ref    VARCHAR(120) NULL,
  failure_code    VARCHAR(40)  NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  confirmed_at    DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_idem (idempotency_key),
  -- Plusieurs NULL sont admis : un paiement n'a pas de référence tant que le
  -- fournisseur ne l'a pas acceptée. Une même référence Orange Money, elle, ne
  -- peut créditer deux comptes.
  UNIQUE KEY uq_payment_ref (provider, provider_ref),
  KEY idx_payment_user (alanyaID, created_at),
  KEY idx_payment_pending (status, created_at),
  CONSTRAINT fk_payment_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_payment_plan FOREIGN KEY (plan_id) REFERENCES plan(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Journal brut de tout ce que les fournisseurs envoient, signature valide ou
-- non. C'est lui qu'on relit quand un paiement est contesté.
CREATE TABLE IF NOT EXISTS payment_event (
  id           BIGINT      NOT NULL AUTO_INCREMENT,
  payment_id   BIGINT      NULL COMMENT 'NULL si la référence est inconnue',
  provider     VARCHAR(32) NOT NULL,
  event_type   VARCHAR(40) NOT NULL,
  signature_ok TINYINT     NOT NULL,
  payload      JSON        NOT NULL,
  received_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pe_payment (payment_id, received_at),
  CONSTRAINT fk_pe_payment FOREIGN KEY (payment_id)
    REFERENCES payment(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS subscription_period (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  alanyaID   INT          NOT NULL,
  plan_id    INT          NOT NULL,
  starts_at  DATETIME     NOT NULL,
  ends_at    DATETIME     NOT NULL,
  source     TINYINT      NOT NULL COMMENT '0=paiement 1=essai 2=offert 3=compensation',
  payment_id BIGINT       NULL,
  granted_by INT          NULL COMMENT 'Administrateur, pour une période offerte',
  reason     VARCHAR(255) NULL COMMENT 'Obligatoire si source = 2',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Un paiement confirmé deux fois ne crée pas deux périodes.
  UNIQUE KEY uq_period_payment (payment_id),
  KEY idx_period_user (alanyaID, ends_at),
  CONSTRAINT ck_period_bounds CHECK (ends_at > starts_at),
  CONSTRAINT fk_period_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_period_plan FOREIGN KEY (plan_id) REFERENCES plan(id),
  CONSTRAINT fk_period_payment FOREIGN KEY (payment_id)
    REFERENCES payment(id) ON DELETE SET NULL,
  CONSTRAINT fk_period_granter FOREIGN KEY (granted_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Une ligne par utilisateur ayant eu au moins une période. Ce qui se déduit
-- des périodes y est dénormalisé pour les balayages d'échéance et de purge.
CREATE TABLE IF NOT EXISTS subscriber (
  alanyaID      INT         NOT NULL,
  current_end   DATETIME    NULL COMMENT 'Fin de la dernière période',
  auto_renew    TINYINT     NOT NULL DEFAULT 0,
  renew_plan_id INT         NULL COMMENT 'Durée choisie pour le prochain renouvellement',
  renew_channel VARCHAR(32) NULL,
  renew_msisdn  VARCHAR(20) NULL,
  purge_after   DATETIME    NULL COMMENT 'Posé à l''échéance : + retention_days',
  purged_at     DATETIME    NULL,
  updated_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
                              ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (alanyaID),
  KEY idx_subscriber_end (current_end),
  KEY idx_subscriber_purge (purge_after, purged_at),
  CONSTRAINT fk_subscriber_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_subscriber_plan FOREIGN KEY (renew_plan_id)
    REFERENCES plan(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Contenu initial ──────────────────────────────────────────────────────

-- Payant activé : non. Tout reste gratuit tant que l'administration n'a pas
-- basculé l'interrupteur.
INSERT IGNORE INTO billing_settings (id) VALUES (1);

INSERT IGNORE INTO feature (code, name_i18n, description_i18n, is_paid, is_available, sort_order) VALUES
  ('translation',
   JSON_OBJECT('fr', 'Traduction des messages', 'en', 'Message translation', 'zh', '消息翻译'),
   JSON_OBJECT('fr', 'Traduire un message, ou toute une conversation, sur le téléphone',
               'en', 'Translate a message, or a whole chat, on your phone',
               'zh', '在手机上翻译单条消息或整个对话'),
   1, 1, 10),
  ('backup',
   JSON_OBJECT('fr', 'Sauvegarde des données', 'en', 'Data backup', 'zh', '备份'),
   JSON_OBJECT('fr', 'Sauvegardes chiffrées, sur le téléphone ou Google Drive',
               'en', 'Encrypted backups, on your phone or Google Drive',
               'zh', '加密备份，保存在手机或 Google 云端硬盘'),
   1, 1, 20),
  ('trusted_trips',
   JSON_OBJECT('fr', 'Trajets de confiance', 'en', 'Trusted trips', 'zh', '安心行程'),
   JSON_OBJECT('fr', 'Partager sa route et son SOS avec sa liste Confiance',
               'en', 'Share your route and SOS with your Trusted list',
               'zh', '与信任名单分享行程和紧急求助'),
   1, 1, 30),
  ('list_ringtones',
   JSON_OBJECT('fr', 'Sonneries par liste', 'en', 'Ringtones by list', 'zh', '按列表设置铃声'),
   JSON_OBJECT('fr', 'Une sonnerie pour la famille, une autre pour le bureau',
               'en', 'One ringtone for family, another for work',
               'zh', '家人和同事使用不同的铃声'),
   1, 1, 40),
  ('style',
   JSON_OBJECT('fr', 'Personnalisation du style', 'en', 'Style customisation', 'zh', '个性化外观'),
   JSON_OBJECT('fr', 'Couleurs et fonds au-delà du clair et du sombre',
               'en', 'Colours and backgrounds beyond light and dark',
               'zh', '浅色和深色之外的配色与背景'),
   1, 0, 50),
  ('verified_badge',
   JSON_OBJECT('fr', 'Coche indigo', 'en', 'Indigo check', 'zh', '靛蓝认证标记'),
   JSON_OBJECT('fr', 'Après vérification de votre identité',
               'en', 'Once your identity is verified',
               'zh', '身份验证通过后显示'),
   1, 1, 60);

INSERT IGNORE INTO plan (code, name_i18n, duration_months, price_amount, currency,
                         reminder_days, is_featured, sort_order) VALUES
  ('plus_mensuel', JSON_OBJECT('fr', 'Mensuel', 'en', 'Monthly', 'zh', '月度'),
   1, 250, 'XAF', 7, 0, 10),
  ('plus_annuel', JSON_OBJECT('fr', 'Annuel', 'en', 'Yearly', 'zh', '年度'),
   12, 2000, 'XAF', 30, 1, 20);

-- Les deux plans incluent toutes les fonctionnalités payantes, y compris celle
-- qui n'est pas encore livrée : elle s'ouvrira d'elle-même le jour venu.
INSERT IGNORE INTO plan_feature (plan_id, feature_code)
  SELECT p.id, f.code FROM plan p CROSS JOIN feature f
   WHERE p.code IN ('plus_mensuel', 'plus_annuel') AND f.is_paid = 1;

INSERT IGNORE INTO scheduler_leases (name) VALUES ('billing_sweep');
