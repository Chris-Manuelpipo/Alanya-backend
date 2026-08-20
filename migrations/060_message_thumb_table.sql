-- 060 — Extraction de message.mediaThumb vers une table satellite (audit
-- scalabilité, palier P1 tranche B). Voir
-- docs/AUDIT_SCALABILITE_2026-08-06.md §2.2.
--
-- message.mediaThumb (MEDIUMTEXT, vignette JPEG base64, ~36 Ko en moyenne
-- mesuré en production le 06/08) est chargée par tous les `SELECT m.*` sur
-- la table la plus chaude du schéma, qu'elle soit utile ou non au chemin
-- concerné. La déplacer dans `message_thumb` allège les pages InnoDB de
-- `message` pour toutes les lectures qui ne l'utilisent pas.
--
-- Stockage en binaire (MEDIUMBLOB) plutôt qu'en base64 (MEDIUMTEXT) :
-- économie d'environ 25% par rapport à l'encodage texte d'origine. Le
-- format base64 est reconstitué à la lecture via TO_BASE64() — le contrat
-- JSON envoyé au client (clé `mediaThumb`, chaîne base64) ne change pas.
--
-- ⚠️ La colonne `message.mediaThumb` N'EST PAS supprimée par cette
-- migration — voir 061_drop_message_mediathumb_column.sql, volontairement
-- non appliquée dans la même passe (garde-fou de rollback, même logique que
-- la migration 053→054 pour l'i18n).

-- message.msgID est BIGINT signé (jamais passé en UNSIGNED) : la colonne de
-- message_thumb doit matcher exactement le même type/signe pour que la FK
-- soit acceptée (MySQL error 3780 sinon).
CREATE TABLE message_thumb (
  msgID BIGINT NOT NULL PRIMARY KEY,
  thumb MEDIUMBLOB NOT NULL,
  CONSTRAINT fk_message_thumb FOREIGN KEY (msgID) REFERENCES message(msgID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill : décode le base64 existant en binaire.
INSERT INTO message_thumb (msgID, thumb)
SELECT msgID, FROM_BASE64(mediaThumb) FROM message
WHERE mediaThumb IS NOT NULL AND mediaThumb <> '';
