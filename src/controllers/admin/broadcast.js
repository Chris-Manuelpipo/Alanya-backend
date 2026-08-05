const pool = require('../../config/db');
const {
  estimateAudience,
  publishBroadcast,
  findBroadcastByClientId,
  mapBroadcastRow,
} = require('../../services/broadcastService');
const { enqueue } = require('../../services/jobQueue');
const { ACCOUNT_TYPE } = require('../../constants/accountTypes');

const listBroadcasts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const [items] = await pool.execute(
      `SELECT b.*, u.nom AS sender_nom
       FROM broadcast b
       JOIN users u ON b.sender_id = u.alanyaID
       ORDER BY b.sent_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
    );

    const [[{ total }]] = await pool.execute('SELECT COUNT(*) AS total FROM broadcast');

    const [scheduled] = await pool.execute(
      `SELECT id AS jobId, payload, run_after AS scheduledAt
       FROM job_queue
       WHERE kind = 'broadcast_send' AND failed_at IS NULL
       ORDER BY run_after ASC
       LIMIT 20`,
    );

    res.json({
      items: items.map(mapBroadcastRow),
      total,
      page,
      limit,
      scheduled: scheduled.map((s) => ({
        jobId: s.jobId,
        scheduledAt: s.scheduledAt,
        payload: typeof s.payload === 'string' ? JSON.parse(s.payload) : s.payload,
      })),
    });
  } catch (e) {
    console.error('[Admin] listBroadcasts:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const getBroadcast = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT b.*, u.nom AS sender_nom FROM broadcast b
       JOIN users u ON b.sender_id = u.alanyaID
       WHERE b.id = ?`,
      [req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Diffusion introuvable' });
    res.json(mapBroadcastRow(rows[0]));
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const estimateBroadcast = async (req, res) => {
  try {
    const { criteria } = req.body || {};
    if (!criteria) return res.status(400).json({ error: 'criteria requis' });
    const result = await estimateAudience(criteria);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

const createBroadcast = async (req, res) => {
  try {
    const {
      senderId,
      kind = 0,
      content,
      type = 0,
      mediaUrl,
      criteria,
      clientId,
      estimate,
      confirmedEstimate,
      scheduledAt,
    } = req.body || {};

    if (!senderId || !criteria || !clientId) {
      return res.status(400).json({ error: 'senderId, criteria et clientId requis' });
    }

    const [senders] = await pool.execute(
      'SELECT alanyaID, account_type FROM users WHERE alanyaID = ?',
      [senderId],
    );
    if (!senders.length || Number(senders[0].account_type) !== ACCOUNT_TYPE.OFFICIEL) {
      return res.status(400).json({ error: 'Expéditeur officiel requis' });
    }

    const { count, criteria: resolved } = await estimateAudience(criteria);
    if (confirmedEstimate != null && Number(confirmedEstimate) !== count) {
      return res.status(409).json({ error: 'Estimation obsolète', count, estimate: count, criteria: resolved });
    }

    const result = await publishBroadcast({
      senderId: Number(senderId),
      createdBy: req.user.alanyaID,
      kind: Number(kind),
      content,
      type: Number(type),
      mediaUrl: mediaUrl || null,
      criteria,
      clientId,
      estimate: estimate ?? count,
      scheduledAt: scheduledAt || null,
    });

    if (result.duplicate) {
      return res.status(409).json({ error: 'clientId déjà utilisé', id: result.id });
    }
    if (result.scheduled) {
      return res.status(201).json(result);
    }
    res.status(201).json(result);
  } catch (e) {
    console.error('[Admin] createBroadcast:', e.message);
    res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};

const cancelScheduled = async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);
    const [rows] = await pool.execute(
      `SELECT id FROM job_queue WHERE id = ? AND kind = 'broadcast_send' AND failed_at IS NULL`,
      [jobId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Job introuvable' });
    await pool.execute('DELETE FROM job_queue WHERE id = ?', [jobId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const listOfficialSenders = async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT alanyaID, nom, pseudo, avatar_url FROM users WHERE account_type = ? ORDER BY nom',
    [ACCOUNT_TYPE.OFFICIEL],
  );
  res.json(rows);
};

module.exports = {
  listBroadcasts,
  getBroadcast,
  estimateBroadcast,
  createBroadcast,
  cancelScheduled,
  listOfficialSenders,
};
