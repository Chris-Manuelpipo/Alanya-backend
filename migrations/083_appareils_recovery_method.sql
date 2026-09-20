-- Migration 083 : `recovery` rejoint le vocabulaire de `appareils.login_method`
--
-- Appliquer après 082. Application manuelle, comme toutes les migrations d'ici.
--
-- ── Pourquoi une quatrième valeur ──
--
-- La connexion par mot de passe va pouvoir être refusée aux appareils inconnus
-- (code `DEVICE_NOT_TRUSTED`). Il ne reste alors que trois portes d'enrôlement :
-- l'inscription, l'approbation par QR depuis un téléphone déjà connecté, et —
-- quand ce téléphone est perdu, volé ou cassé — la réinitialisation du mot de
-- passe. Cette troisième voie n'a aujourd'hui aucun nom : `recordLogin` refuse
-- tout `login_method` hors vocabulaire, et y écrire 'password' rendrait un
-- enrôlement de secours indistinguable d'une connexion ordinaire, aussi bien
-- dans l'écran « Appareils connectés » que dans une enquête après vol.
--
-- MODIFY et non ADD : un ENUM MySQL se réécrit en entier. Les trois valeurs
-- existantes restent dans la liste et dans le même ordre, donc aucune ligne
-- déjà posée ne change. Rejouer ce MODIFY sur une colonne déjà modifiée est
-- sans effet : la migration est réexécutable.

ALTER TABLE appareils
  MODIFY COLUMN login_method ENUM('password','register','qr','recovery') NOT NULL;
