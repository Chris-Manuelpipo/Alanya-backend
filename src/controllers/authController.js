const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
require('dotenv').config();

const register = async (req, res) => {
  try {
    const firebaseUid = req.firebaseUser?.uid;
    if (!firebaseUid) {
      return res.status(401).json({ error: 'Token Firebase invalide' });
    }

    const phone =
      (req.firebaseUser?.phone && req.firebaseUser.phone.trim()) ||
      (req.body?.phone && String(req.body.phone).trim()) ||
      null;

    if (!phone) {
      return res.status(400).json({
        error: 'phone required (in token or body)',
      });
    }

    const { nom, pseudo, avatar_url, idPays, fcm_token, device_ID } = req.body;

    const setPhoneClaim = async () => {
      const fbUser = await admin.auth().getUser(firebaseUid);
      const existing = fbUser.customClaims || {};
      if (existing.talky_phone === phone) return;
      await admin.auth().setCustomUserClaims(firebaseUid, {
        ...existing,
        talky_phone: phone,
      });
      const verify = await admin.auth().getUser(firebaseUid);
      const got = verify.customClaims?.talky_phone;
      if (got !== phone) {
        throw new Error(
          `Alanya phone reclamé (${phone}) diffère de celui dans Firebase (${got})`,
        );
      }
    };

    // Vérification en 2 étapes pour éviter les doublons de téléphone :
    // L'utilisateur existe-t-il déjà ? (match par téléphone)
    const [byPhone] = await pool.execute(
      'SELECT alanyaID FROM users WHERE alanyaPhone = ?',
      [phone]
    );

    if (byPhone.length > 0) {
      const alanyaID = byPhone[0].alanyaID;
      const updates = [];
      const values = [];

      if (nom)        { updates.push('nom = ?');        values.push(nom); }
      if (pseudo)     { updates.push('pseudo = ?');     values.push(pseudo); }
      if (avatar_url) { updates.push('avatar_url = ?'); values.push(avatar_url); }
      if (fcm_token)  { updates.push('fcm_token = ?');  values.push(fcm_token); }
      if (device_ID)  { updates.push('device_ID = ?');  values.push(device_ID); }

      if (updates.length > 0) {
        values.push(alanyaID);
        await pool.execute(
          `UPDATE users SET ${updates.join(', ')} WHERE alanyaID = ?`,
          values
        );
      }

      await setPhoneClaim();

      const [rows] = await pool.execute(
        'SELECT alanyaID, nom, pseudo, alanyaPhone, avatar_url, is_online, last_seen FROM users WHERE alanyaID = ?',
        [alanyaID]
      );
      return res.json(rows[0]);
    }

    // Nouvel utilisateur
    const [result] = await pool.execute(
      `INSERT INTO users
         (nom, pseudo, alanyaPhone, idPays, password, avatar_url,
          fcm_token, device_ID, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        nom || 'Utilisateur',
        pseudo || nom || 'Kamite',
        phone,
<<<<<<< HEAD
        idPays || 10,
=======
        idPays || 1,
>>>>>>> 8a90f7ef9ac7fb9772ef63710a2c1b4705e094d9
        '',
        avatar_url || 'NON DEFINI',
        fcm_token || 'INDEFINI',
        device_ID || 'INDEFINI',
      ]
    );

    await setPhoneClaim();

    const [rows] = await pool.execute(
      'SELECT alanyaID, nom, pseudo, alanyaPhone, avatar_url, is_online, last_seen FROM users WHERE alanyaID = ?',
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('[Register] ERROR:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
};

const phoneExists = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) {
      return res.status(400).json({ error: 'Alanya phone requis' });
    }
    const [rows] = await pool.execute(
      'SELECT alanyaID FROM users WHERE alanyaPhone = ?',
      [phone]
    );
    res.json({
      exists: rows.length > 0,
      alanyaID: rows.length > 0 ? rows[0].alanyaID : null,
    });
  } catch (error) {
    console.error('[PhoneExists] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

const verifyToken = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT alanyaID, nom, pseudo, alanyaPhone, avatar_url, is_online FROM users WHERE alanyaID = ?',
      [req.user.alanyaID]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    res.json({ user: rows[0] });
  } catch (error) {
    throw error;
  }
};

const getMe = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT alanyaID, nom, pseudo, alanyaPhone, idPays, avatar_url, type_compte, is_online, last_seen FROM users WHERE alanyaID = ?',
      [req.user.alanyaID]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    res.json(rows[0]);
  } catch (error) {
    throw error;
  }
};

const updateMe = async (req, res) => {
  try {
    const { nom, pseudo, avatar_url, fcm_token, device_ID, is_online } = req.body;
    const updates = [];
    const values = [];

    if (nom)       { updates.push('nom = ?');       values.push(nom); }
    if (pseudo)    { updates.push('pseudo = ?');    values.push(pseudo); }
    if (avatar_url){ updates.push('avatar_url = ?'); values.push(avatar_url); }
    if (fcm_token) { updates.push('fcm_token = ?'); values.push(fcm_token); }
    if (device_ID) { updates.push('device_ID = ?'); values.push(device_ID); } 
    if (is_online !== undefined) {
      updates.push('is_online = ?, last_seen = NOW()');
      values.push(is_online ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    }

    values.push(req.user.alanyaID);
    await pool.execute(
      `UPDATE users SET ${updates.join(', ')} WHERE alanyaID = ?`,
      values
    );

    const [rows] = await pool.execute(
      'SELECT alanyaID, nom, pseudo, alanyaPhone, avatar_url, is_online FROM users WHERE alanyaID = ?',
      [req.user.alanyaID]
    );

    res.json(rows[0]);
  } catch (error) {
    throw error;
  }
};

module.exports = {
  verifyToken,
  getMe,
  updateMe,
  register,
  phoneExists,
};