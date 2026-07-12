-- Vignette vidéo transmise avec le message (aperçu type WhatsApp).
-- L'expéditeur génère une mini-vignette JPEG de la première frame, l'encode en
-- base64 et la transmet dans le message. Le destinataire l'affiche immédiatement
-- (y compris hors ligne) sans télécharger la vidéo complète.
ALTER TABLE message
  ADD COLUMN mediaThumb MEDIUMTEXT NULL COMMENT 'Vignette vidéo (JPEG base64) pour aperçu destinataire';
