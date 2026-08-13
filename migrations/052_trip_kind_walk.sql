-- Remplace le type « rendez-vous » (meeting) par « à pied » (walk).
-- Les trajets déjà créés en meeting sont migrés ; l'ENUM ne conserve plus meeting.
-- Défaut produit : taxi.

ALTER TABLE trip
  MODIFY COLUMN kind ENUM('taxi','meeting','walk','sos') NOT NULL DEFAULT 'taxi';

UPDATE trip SET kind = 'walk' WHERE kind = 'meeting';

ALTER TABLE trip
  MODIFY COLUMN kind ENUM('taxi','walk','sos') NOT NULL DEFAULT 'taxi';
