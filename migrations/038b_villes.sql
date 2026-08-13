-- Migration 038b : référentiel villes + idVille sur users
-- genre, age, ville (VARCHAR) existent déjà en 037.

CREATE TABLE IF NOT EXISTS ville (
  idVille       SMALLINT     NOT NULL AUTO_INCREMENT,
  libelle       VARCHAR(120) NOT NULL,
  libelle_norm  VARCHAR(120) NOT NULL COMMENT 'lowercase unaccented pour lookup',
  idPays        SMALLINT     NOT NULL,
  PRIMARY KEY (idVille),
  UNIQUE KEY uq_ville_pays (idPays, libelle),
  UNIQUE KEY uq_ville_pays_norm (idPays, libelle_norm),
  CONSTRAINT fk_ville_pays FOREIGN KEY (idPays) REFERENCES pays(idPays)
);

ALTER TABLE users
  ADD COLUMN idVille SMALLINT NULL,
  ADD INDEX idx_users_idVille (idVille),
  ADD INDEX idx_users_genre (genre),
  ADD INDEX idx_users_age (age);

ALTER TABLE users
  ADD CONSTRAINT fk_users_ville FOREIGN KEY (idVille) REFERENCES ville(idVille);
