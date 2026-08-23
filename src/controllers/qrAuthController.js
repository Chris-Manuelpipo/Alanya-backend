const pool = require('../config/db');
const { generateAccessToken, generateRefreshToken } = require('../middleware/authCustom');
const deviceSessionService = require('../services/deviceSessionService');
const { normalizePlatform } = deviceSessionService;
const { emitToUser, disconnectAppareilSockets } = require('../utils/userSocketRegistry');
const { getClientIp } = require('../utils/clientIp');
const qrLoginSessions = require('../socket/state/qrLoginSessions');
const { loginPayload, secretMatches } = require('../utils/qrToken');
const { lookupLocation } = require('../services/ipGeoService');

// Le QR encode une URL et non une donnée brute : un scan par un appareil photo
// générique tombe sur une page web plutôt que sur une chaîne incompréhensible.
// La fabrication du payload vit dans utils/qrToken, avec celle des QR
// d'identité, pour que qrController.js les reparse toujours sous la même base.


const _trimmed = (value, max) => {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s.slice(0, max);
};

// Ouvre une session de connexion par QR — l'appareil demandeur n'est pas encore
// authentifié, c'est tout l'objet de la manœuvre.
const createQrSession = async (req, res) => {
  try {
    const deviceId = _trimmed(req.body.deviceId || req.body.device_ID || req.body.device_id, 128);
    if (!deviceId || deviceId === 'INDEFINI') {
      return res.status(400).json({ error: 'deviceId requis' });
    }

    // `deviceName` et `platform` viennent d'un appelant NON authentifié : ils
    // s'afficheront tels quels sur l'écran de confirmation, seul rempart contre
    // le quishing. La plateforme est donc contrainte à un vocabulaire fermé dès
    // ici (et non au moment de recordLogin, trop tard car après approbation) ;
    // le libellé libre, lui, est borné court et présenté côté client comme
    // « déclaré par l'appareil », jamais comme un fait vérifié.
    const entry = qrLoginSessions.create({
      deviceId,
      deviceName: _trimmed(req.body.deviceName || req.body.device_model, 60),
      platform: normalizePlatform(req.body.platform || req.body.os_system),
      ipAddress: _trimmed(getClientIp(req), 64),
    });

    // Géolocalisation lancée ici, sans être attendue : elle n'a que le temps du
    // scan pour aboutir (quelques secondes), et surtout elle ne doit jamais
    // retarder ni faire échouer l'ouverture de la session.
    lookupLocation(entry.ipAddress)
      .then((lieu) => {
        const vivante = qrLoginSessions.get(entry.sessionId);
        if (vivante && lieu) vivante.location = lieu;
      })
      .catch(() => {});

    console.log(`[QrAuth] session créée sessionId=${entry.sessionId} platform=${entry.platform ?? 'INDEFINI'}`);

    // Seul endroit où le pollToken sort du serveur : il n'est remis qu'à
    // l'appareil qui vient de créer la session.
    res.json({
      sessionId: entry.sessionId,
      scanSecret: entry.scanSecret,
      pollToken: entry.pollToken,
      payload: loginPayload(entry.sessionId, entry.scanSecret),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      // Durée et non seulement date de fin : le client décompte à partir de
      // l'instant de RÉCEPTION, sans jamais comparer son horloge à la nôtre.
      // Une horloge d'appareil en avance de plus de 90 s rendrait sinon le code
      // expiré dès son affichage, et le ferait régénérer en boucle.
      ttlMs: qrLoginSessions.TTL_MS,
    });
  } catch (error) {
    console.error('[QrAuth] createQrSession ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec de la création de la session' });
  }
};

// Interrogation du statut par l'appareil demandeur (non authentifié).
const getQrSessionStatus = async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || '');
    // En-tête et non query string : l'URL complète est journalisée par défaut
    // par nginx/Cloudflare, alors que la réponse correspondante transporte
    // accessToken et refreshToken. Le sessionId étant public (il est dans le
    // QR), le pollToken est le seul facteur — il ne doit pas finir en clair
    // dans un journal d'accès.
    const pollToken = req.get('X-Poll-Token');
    if (!pollToken) {
      return res.status(400).json({ error: 'pollToken requis' });
    }

    const entry = qrLoginSessions.get(sessionId);

    // Session absente OU pollToken faux : même réponse. Distinguer les deux
    // laisserait, avec le seul sessionId (public), sonder l'existence d'une
    // session vivante.
    if (!entry || !secretMatches(pollToken, entry.pollToken)) {
      return res.json({ status: 'expired' });
    }

    if (entry.status === 'approved') {
      const result = entry.result || {};
      // Livraison à usage unique : les tokens ne repassent jamais par ce canal.
      qrLoginSessions.clear(sessionId);
      console.log(`[QrAuth] tokens livrés sessionId=${sessionId}`);
      return res.json({
        status: 'approved',
        user: result.user ?? null,
        accessToken: result.accessToken ?? null,
        refreshToken: result.refreshToken ?? null,
      });
    }

    res.json({ status: entry.status });
  } catch (error) {
    console.error('[QrAuth] getQrSessionStatus ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec de la lecture de la session' });
  }
};

// Charge la session et vérifie le scanSecret pour les actions de l'appareil qui
// a scanné (approve / deny). Répond lui-même en cas d'échec.
const _loadScannedSession = (req, res) => {
  const sessionId = String(req.params.sessionId || '');
  const scanSecret = req.body?.scanSecret;
  if (!scanSecret) {
    res.status(400).json({ error: 'scanSecret requis' });
    return null;
  }

  const entry = qrLoginSessions.get(sessionId);
  if (!entry || !secretMatches(scanSecret, entry.scanSecret)) {
    res.status(404).json({ error: 'Session inconnue ou expirée' });
    return null;
  }

  if (entry.status !== 'pending' && entry.status !== 'scanned') {
    res.status(409).json({ error: 'Session déjà traitée' });
    return null;
  }

  return entry;
};

// Approbation depuis un appareil DÉJÀ connecté, après confirmation explicite de
// l'utilisateur sur un écran dédié — jamais depuis /api/qr/resolve.
const approveQrSession = async (req, res) => {
  let reserved = null;
  try {
    const entry = _loadScannedSession(req, res);
    if (!entry) return;

    // Réservation AVANT tout await : deux confirmations quasi simultanées
    // franchiraient sinon toutes deux la garde de statut, et la seconde
    // écraserait le résultat de la première — l'appareil demandeur ouvrirait
    // le compte du second.
    reserved = qrLoginSessions.beginApproval(entry.sessionId);
    if (!reserved) {
      return res.status(409).json({ error: 'Session déjà traitée' });
    }

    const alanyaID = req.user.alanyaID;

    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.avatar_url,
              up.is_online AS is_online
       FROM users u
       LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
       WHERE u.alanyaID = ?`,
      [alanyaID]
    );
    if (rows.length === 0) {
      qrLoginSessions.abortApproval(entry.sessionId);
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    const user = rows[0];

    // L'appareil enregistré est le DEMANDEUR (celui qui affiche le QR), pas
    // celui qui approuve : c'est lui qui va porter la nouvelle session.
    const appareilId = await deviceSessionService.recordLogin({
      alanyaID,
      deviceId: entry.deviceId,
      deviceName: entry.deviceName,
      platform: entry.platform,
      ipAddress: entry.ipAddress,
      loginMethod: 'qr',
    });

    if (!appareilId) {
      qrLoginSessions.abortApproval(entry.sessionId);
      console.error('[QrAuth] recordLogin a échoué — approbation refusée (session serait irrévocable)');
      return res.status(503).json({ error: 'Service temporairement indisponible' });
    }

    const tokenPayload = { alanyaID, email: user.email, appareilId };
    const accessToken  = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    // La session a pu expirer pendant les await ci-dessus. Sans ce test, on
    // annoncerait « approuvé » et on émettrait une paire de tokens que
    // personne ne viendra chercher, en laissant une ligne `appareils` orpheline.
    const approved = qrLoginSessions.approve(entry.sessionId, {
      scannedByAlanyaID: alanyaID,
      result: { user, accessToken, refreshToken },
    });
    if (!approved) {
      await pool.execute('DELETE FROM appareils WHERE id = ?', [appareilId]).catch(() => {});
      return res.status(410).json({
        error: 'Session expirée pendant la confirmation',
        code: 'QR_SESSION_EXPIRED',
      });
    }

    const io = req.app.get('io');

    // Même signal que pour une connexion par mot de passe : les autres
    // appareils du compte sont informés qu'une session vient de s'ouvrir.
    emitToUser(io, alanyaID, 'auth:conflict', {
      deviceName: entry.deviceName || 'INDEFINI',
      platform: entry.platform || 'INDEFINI',
      loginMethod: 'qr',
      at: new Date().toISOString(),
    });

    // Plomberie pour le futur client web : la room ne transporte QUE le statut,
    // jamais les tokens — ceux-ci restent sur le poll HTTP à usage unique.
    if (io) {
      io.to(`qr_session_${entry.sessionId}`).emit('qr_session:update', {
        sessionId: entry.sessionId,
        status: 'approved',
      });
    }

    console.log(`[QrAuth] session approuvée sessionId=${entry.sessionId} user=${alanyaID} appareil=${appareilId ?? 'none'}`);
    res.json({ ok: true });
  } catch (error) {
    if (reserved) qrLoginSessions.abortApproval(reserved.sessionId);
    console.error('[QrAuth] approveQrSession ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec de l\'approbation' });
  }
};

const denyQrSession = async (req, res) => {
  try {
    const entry = _loadScannedSession(req, res);
    if (!entry) return;

    qrLoginSessions.deny(entry.sessionId);

    const io = req.app.get('io');
    if (io) {
      io.to(`qr_session_${entry.sessionId}`).emit('qr_session:update', {
        sessionId: entry.sessionId,
        status: 'denied',
      });
    }

    console.log(`[QrAuth] session refusée sessionId=${entry.sessionId} user=${req.user.alanyaID}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('[QrAuth] denyQrSession ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec du refus' });
  }
};

// Liste des appareils connectés. On n'expose ni device_id ni ip_address : le
// premier est une empreinte matérielle réutilisable, la seconde une donnée de
// localisation, et l'écran n'a besoin ni de l'un ni de l'autre pour laisser
// l'utilisateur reconnaître ses appareils (libellé + plateforme + dates).
const listDeviceSessions = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, device_name, platform, login_method, created_at, last_active_at
       FROM appareils
       WHERE alanyaID = ? AND revoked_at IS NULL
       ORDER BY last_active_at DESC`,
      [req.user.alanyaID]
    );

    res.json(rows.map((r) => ({
      id: r.id,
      deviceName: r.device_name,
      platform: r.platform,
      loginMethod: r.login_method,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      current: req.user.appareilId != null && Number(r.id) === Number(req.user.appareilId),
    })));
  } catch (error) {
    console.error('[QrAuth] listDeviceSessions ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec de la lecture des appareils' });
  }
};

const revokeDeviceSession = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Identifiant d\'appareil invalide' });
    }

    // 404 et non 403 quand la ligne appartient à quelqu'un d'autre : répondre
    // 403 divulguerait l'existence de l'appareil d'un autre compte.
    const [rows] = await pool.execute(
      'SELECT id, device_id FROM appareils WHERE id = ? AND alanyaID = ?',
      [id, req.user.alanyaID]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Appareil introuvable' });
    }

    await pool.execute(
      'UPDATE appareils SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL',
      [id]
    );

    const io = req.app.get('io');

    // Confort d'UX : on diffuse à tout le compte l'identifiant MATÉRIEL révoqué,
    // chaque client se reconnaît lui-même et se déconnecte proprement.
    emitToUser(io, req.user.alanyaID, 'auth:device_revoked', {
      appareilId: id,
      deviceId: rows[0].device_id,
    });

    // Garantie dure, elle : le 401 du middleware ferme REST, cette fermeture
    // ferme le temps réel. Après l'emit, pour que le client reçoive l'event
    // avant que sa socket ne tombe.
    const fermees = disconnectAppareilSockets(io, req.user.alanyaID, id);

    console.log(`[QrAuth] appareil révoqué id=${id} user=${req.user.alanyaID} sockets=${fermees}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('[QrAuth] revokeDeviceSession ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec de la révocation' });
  }
};

module.exports = {
  createQrSession,
  getQrSessionStatus,
  approveQrSession,
  denyQrSession,
  listDeviceSessions,
  revokeDeviceSession,
};
