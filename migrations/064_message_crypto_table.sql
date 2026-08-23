-- 064 — Table message_crypto : extraction des colonnes de chiffrement E2E
-- de `message` (fractionnement par colonnes). Ces colonnes n'existent dans
-- aucune migration de `main` ni dans le code de `main` — elles proviennent
-- de la branche `chiffrement-messages`, en pause. Extraction pure schéma :
-- aucun fichier .js de main ne les référence, donc aucun changement de code
-- n'est nécessaire. Les données sont préservées intégralement (pas de perte,
-- même si actuellement illisible sans le code de `chiffrement-messages`,
-- qui les reprendra le moment venu).
--
-- msgID en BIGINT signé (pas UNSIGNED) : doit matcher exactement le type de
-- message.msgID pour que la FK soit acceptée par MySQL (cf. erreur 3780
-- rencontrée sur message_thumb, migration 060).

CREATE TABLE message_crypto (
  msgID                BIGINT        NOT NULL PRIMARY KEY,
  ciphertext           MEDIUMBLOB    NULL,
  dr_nonce             VARBINARY(16) NULL,
  dr_header            TEXT          NULL,
  archive_blob         MEDIUMBLOB    NULL,
  signal_message_type  TINYINT       NULL,
  CONSTRAINT fk_message_crypto FOREIGN KEY (msgID) REFERENCES message(msgID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO message_crypto (msgID, ciphertext, dr_nonce, dr_header, archive_blob, signal_message_type)
SELECT msgID, ciphertext, dr_nonce, dr_header, archive_blob, signal_message_type
FROM message
WHERE ciphertext IS NOT NULL OR dr_nonce IS NOT NULL OR dr_header IS NOT NULL
   OR archive_blob IS NOT NULL OR signal_message_type IS NOT NULL;
