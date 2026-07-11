-- Idempotence des envois client : un même clientId par expéditeur ne doit
-- créer qu'un seul message serveur (évite les doublons après reconnexion).
-- La colonne clientID existe déjà sur `message`.

CREATE UNIQUE INDEX uq_message_sender_client
  ON message (senderID, clientID);
