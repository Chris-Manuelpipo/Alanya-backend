-- 062 — Table user_presence : extraction de is_online/last_seen (audit
-- scalabilité, fractionnement par colonnes). `is_online`/`last_seen` sont
-- écrites à chaque connexion/déconnexion/bascule premier plan-arrière plan
-- de chaque utilisateur, en contention documentée avec le SELECT ... FOR
-- UPDATE de materializeForUser (broadcastService.js) qui verrouille toute
-- la ligne `users`. Les extraire supprime cette contention sans changer la
-- stratégie de verrouillage de materializeForUser.
--
-- `in_call` (colonne confirmée morte : aucun code ne la lit ni ne l'écrit)
-- et `fcm_token` (legacy actif mais conceptuellement un jeton d'appareil,
-- déjà modélisé par user_push_devices) restent hors périmètre.
--
-- ⚠️ Cette migration ne retire RIEN de `users` — elle crée et peuple la
-- nouvelle table uniquement. Le code applicatif continue de lire/écrire
-- `users.is_online`/`last_seen` tant que le code n'a pas été migré (voir
-- 063, différée). Aucun risque à l'appliquer avant le code.

CREATE TABLE user_presence (
  alanyaID  INT      NOT NULL PRIMARY KEY,
  is_online TINYINT  NOT NULL DEFAULT 0,
  last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_presence FOREIGN KEY (alanyaID) REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO user_presence (alanyaID, is_online, last_seen)
SELECT alanyaID, is_online, last_seen FROM users;
