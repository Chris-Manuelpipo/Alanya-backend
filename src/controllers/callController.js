const pool = require('../config/db');
const { isBlockedEitherWay } = require('../utils/blockUtils');
const { getClientIp, parseCallMode } = require('../utils/clientIp');
const { processRejectCall } = require('../socket/handlers/calls');
 
// Récupère l'historique des appels de l'utilisateur connecté
const getCalls = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT c.*,
              u1.nom as caller_nom, u1.pseudo as caller_pseudo, u1.avatar_url as caller_avatar,
              u2.nom as receiver_nom, u2.pseudo as receiver_pseudo, u2.avatar_url as receiver_avatar
       FROM callHistory c
       JOIN users u1 ON c.idCaller   = u1.alanyaID
       JOIN users u2 ON c.idReceiver = u2.alanyaID
       WHERE c.idCaller = ? OR c.idReceiver = ?
       ORDER BY c.created_at DESC
       LIMIT 50`,
      [alanyaID, alanyaID]
    );
    res.json(rows);
  } catch (error) {
    throw error;
  }
};

// Crée un nouvel appel (type 0 = audio, 1 = vidéo)
const createCall = async (req, res) => {
  try {
    const { idReceiver, type = 0 } = req.body;
    const idCaller = req.user.alanyaID;

    if (!idReceiver) {
      return res.status(400).json({ error: 'idReceiver required' });
    }

    if (await isBlockedEitherWay(idCaller, idReceiver)) {
      return res.status(403).json({ error: 'Appel impossible', code: 'CALL_BLOCKED' });
    }

    const callerIp = getClientIp(req);
    const [result] = await pool.execute(
      `INSERT INTO callHistory (idCaller, idReceiver, type, status, created_at, start_time, ip)
       VALUES (?, ?, ?, 0, NOW(), NOW(), ?)`,
      [idCaller, idReceiver, type, callerIp]
    );

    const [rows] = await pool.execute(
      `SELECT c.*, u.nom as receiver_nom, u.pseudo as receiver_pseudo
       FROM callHistory c
       JOIN users u ON c.idReceiver = u.alanyaID
       WHERE c.IDcall = ?`,   
      [result.insertId]
    );

    res.json(rows[0]);
  } catch (error) {
    throw error;
  }
};

// Met à jour le statut de l'appel (0 = en cours, 1 = terminé, 2 = manqué)
const endCall = async (req, res) => {
  try {
    const { id }       = req.params;
    const { status = 1, mode: rawMode } = req.body;
    const alanyaID     = req.user.alanyaID;
    const mode = parseCallMode(rawMode);
 
    await pool.execute(
      `UPDATE callHistory
       SET status = ?,
           duree  = GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW())),
           mode   = COALESCE(?, mode)
       WHERE IDcall = ? AND (idCaller = ? OR idReceiver = ?)`,
      [status, mode, id, alanyaID, alanyaID]
    );

    res.json({ message: 'Call ended' });
  } catch (error) {
    throw error;
  }
};

/**
 * Refus d'appel via HTTP — utilisé quand Flutter/CallKit refuse sans socket prêt
 * (app tuée + bouton Refuser de la notification).
 * Body: { callerId, callId? }
 */
const rejectCallHttp = async (req, res) => {
  try {
    const callerID = parseInt(req.body?.callerId, 10);
    const callIdHint = req.body?.callId ?? null;
    const receiverID = req.user.alanyaID;

    if (!callerID || Number.isNaN(callerID)) {
      return res.status(400).json({ error: 'callerId required' });
    }

    const io = req.app.get('io');
    const userSockets = req.app.get('userSockets');

    const result = await processRejectCall({
      io,
      userSockets,
      callerID,
      receiverID,
      callIdHint,
    });

    res.json({ ok: true, callId: result.callId ?? null });
  } catch (error) {
    throw error;
  }
};

module.exports = { getCalls, createCall, endCall, rejectCallHttp };
