-- Migration 069 : bail du balayage de péremption des trajets
--
-- La péremption d'un trajet (« la position n'arrive plus ») était portée par un
-- setTimeout par trajet, réarmé à chaque position GPS reçue. Ce mécanisme ne
-- survit ni au redémarrage du process, ni au passage à plusieurs instances.
--
-- Il est remplacé par un balayage périodique unique adossé à un index
-- d'échéances Redis. « Unique » est le mot important : sans bail, deux serveurs
-- annonceraient chacun la même perte de signal au cercle du trajet.
--
-- `tryAcquire` sème la ligne à la volée si elle manque (INSERT IGNORE), donc
-- cette migration n'est pas strictement obligatoire — elle rend simplement le
-- bail visible dans la table dès le départ, au même titre que les autres.

INSERT IGNORE INTO scheduler_leases (name) VALUES ('trip_stale_sweep');
