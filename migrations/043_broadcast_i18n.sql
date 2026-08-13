-- Migration 043 : contenu bilingue pour diffusions et statuts officiels

ALTER TABLE broadcast
  ADD COLUMN content_en TEXT NULL AFTER content;

ALTER TABLE statut
  ADD COLUMN text_en TINYTEXT NULL AFTER text;
