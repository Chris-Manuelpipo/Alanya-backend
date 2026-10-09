-- Migration 091 : `appareils.hevc_decode`, ce que chaque appareil sait lire
--
-- Appliquer après 090. Application manuelle, comme toutes les migrations d'ici.
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` (cf. migration 026) : si
-- relancée après un premier passage réussi, ignorer l'erreur 1060 (Duplicate
-- column name) à l'exécution.
--
-- Ordre de déploiement : indifférent. Sans la colonne, le code se comporte
-- comme si aucun appareil ne lisait le HEVC (toutes les vidéos partent en
-- H.264, comme aujourd'hui) et ignore les déclarations des téléphones.
--
-- ── À quoi elle sert ──
--
-- Une vidéo compressée en HEVC pèse un tiers de moins qu'en H.264, à qualité
-- égale. Mais Android ne garantit sa lecture que jusqu'au 540p : un téléphone
-- ancien ou très bon marché peut ne pas la lire. Chaque téléphone déclare donc,
-- une fois par session, s'il lit le HEVC en 720p par une puce dédiée
-- (`PUT /api/users/me/video-capabilities`). Avant d'envoyer une vidéo, l'app
-- demande au serveur si TOUS les appareils actifs des membres de la discussion
-- la liront (`GET /api/conversations/:id/video-codecs`).
--
-- ── Pourquoi NULL par défaut ──
--
-- NULL = inconnu : un appareil sur une ancienne version de l'app ne déclare
-- rien. Il compte comme incapable, et la discussion reste en H.264 tant qu'il
-- est actif. La part de vidéos en HEVC grandit à mesure des mises à jour.

ALTER TABLE appareils
  ADD COLUMN hevc_decode TINYINT(1) NULL DEFAULT NULL
    COMMENT '1 lit le HEVC 720p par une puce, 0 non, NULL inconnu (ancienne app)';
