-- Ajoute le mode de connexion WebRTC et l'IP de l'appelant à l'historique d'appels.
-- mode: 0 = relay/TURN, 1 = P2P (host + srflx), NULL = inconnu
-- ip: adresse IP de l'appelant au moment de call_user (vue serveur)

ALTER TABLE callHistory
  ADD COLUMN mode TINYINT NULL DEFAULT NULL
    COMMENT '0=relay/TURN 1=P2P(host+srflx) NULL=inconnu',
  ADD COLUMN ip VARCHAR(45) NULL DEFAULT NULL
    COMMENT 'IP appelant au moment de call_user';
