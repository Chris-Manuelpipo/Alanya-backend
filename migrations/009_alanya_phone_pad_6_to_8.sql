-- Migration 009: Pad existing 6-digit alanyaPhone values to 8 digits (left zero pad)

UPDATE users
SET alanyaPhone = LPAD(alanyaPhone, 8, '0')
WHERE LENGTH(alanyaPhone) = 6;
