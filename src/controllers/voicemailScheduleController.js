/**
 * Réglage du répondeur : lecture et mise à jour partielle.
 *
 * Forme reprise de `dndScheduleController` (mêmes conventions de patch, mêmes
 * codes d'erreur), avec trois ajouts que le DND n'a pas :
 *
 * — la réponse porte l'état CALCULÉ (`active`, `activeUntil`, `resolvedTimezone`)
 *   en plus de la règle brute. Le client n'a alors aucun calcul de fuseau à
 *   refaire, et il lui suffit d'armer un minuteur sur `activeUntil` pour que son
 *   bandeau disparaisse tout seul, sans rappeler le serveur ;
 *
 * — `bypassListId` est vérifié : une liste qu'on ne possède pas ne doit pas
 *   pouvoir être désignée, sinon n'importe qui ferait d'une liste étrangère sa
 *   porte d'entrée ;
 *
 * — chaque écriture est annoncée aux autres appareils du compte. Sans ça, le
 *   second téléphone garde un bandeau périmé jusqu'à son prochain retour au
 *   premier plan.
 */

const pool = require('../config/db');
const { emitToUser } = require('../utils/userSocketRegistry');
const {
  loadUserVoicemailSchedule,
  upsertUserVoicemailSchedule,
  isVoicemailActive,
  activeUntil,
} = require('../services/voicemailScheduleService');
const { replaceSlots, MAX_SLOTS_PER_DAY } = require('../services/voicemailSlots');

const _toBool = (v) => v === true || v === 1 || v === '1';

/** `HH:MM:SS` de la base → `HH:MM`. Le client ne manipule pas les secondes. */
const _formatTime = (value) => {
  if (value == null) return null;
  const raw = String(value);
  return raw.length >= 5 ? raw.slice(0, 5) : raw;
};

const _formatSchedule = (schedule, now = new Date()) => {
  const tz = schedule.resolvedTimezone;
  const fin = activeUntil(schedule, now, tz);
  return {
    // Les deux modes qui rendent le téléphone muet, exclusifs entre eux.
    enabled: _toBool(schedule.enabled),
    untilAt: schedule.untilAt ? new Date(schedule.untilAt).toISOString() : null,
    slots: (schedule.slots || []).map((s) => ({
      dayBit: Number(s.dayBit),
      startTime: _formatTime(s.startTime),
      endTime: _formatTime(s.endTime),
    })),
    // Le filet, indépendant et cumulable : le téléphone sonne quand même.
    noAnswerEnabled: _toBool(schedule.no_answer_enabled),
    timezone: schedule.timezone ?? null,
    bypassListId: schedule.bypassListId == null ? null : Number(schedule.bypassListId),
    greetingUrl: schedule.greeting_url ?? null,
    greetingSeconds:
      schedule.greeting_seconds == null ? null : Number(schedule.greeting_seconds),
    // État calculé — lecture seule côté client. Ne reflète QUE les modes muets :
    // le filet sans-réponse n'« active » rien, il attend.
    active: isVoicemailActive(schedule, now, tz),
    activeUntil: fin ? fin.toISOString() : null,
    resolvedTimezone: tz,
    maxSlotsPerDay: MAX_SLOTS_PER_DAY,
  };
};

/**
 * `null` explicite et absence de clé ne veulent pas dire la même chose :
 * `untilAt: null` éteint l'activation ponctuelle, `untilAt` absent la laisse
 * telle quelle. C'est ce qui permet au bouton « Désactiver » du bandeau
 * d'envoyer `{ untilAt: null, enabled: false }` et de tout éteindre d'un geste.
 *
 * `slots` ne passe PAS par ce patch : les plages vivent dans leur propre table
 * et se remplacent en bloc, séparément.
 */
const _normalizePatch = (body = {}) => {
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = _toBool(body.enabled) ? 1 : 0;
  if (body.noAnswerEnabled !== undefined) {
    patch.no_answer_enabled = _toBool(body.noAnswerEnabled) ? 1 : 0;
  }
  if (body.untilAt !== undefined) patch.untilAt = body.untilAt;
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.bypassListId !== undefined) patch.bypassListId = body.bypassListId;
  return patch;
};

/** La liste désignée existe-t-elle, et appartient-elle bien à ce compte ? */
const _listeAppartientA = async (idList, alanyaID) => {
  const [rows] = await pool.execute(
    'SELECT 1 FROM contact_list WHERE idList = ? AND alanyaID = ? LIMIT 1',
    [idList, alanyaID],
  );
  return rows.length > 0;
};

const getVoicemailSchedule = async (req, res) => {
  try {
    const schedule = await loadUserVoicemailSchedule(req.user.alanyaID);
    res.json(_formatSchedule(schedule));
  } catch (error) {
    console.error('[VoicemailSchedule] get error:', error.message);
    res.status(500).json({ error: 'Erreur interne', code: 'INTERNAL' });
  }
};

const patchVoicemailSchedule = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const patch = _normalizePatch(req.body);
    const plages = Array.isArray(req.body?.slots) ? req.body.slots : null;

    if (Object.keys(patch).length === 0 && plages == null) {
      return res.status(400).json({
        error: 'Aucun paramètre valide fourni',
        code: 'NO_FIELDS_TO_UPDATE',
      });
    }

    if (patch.bypassListId != null && patch.bypassListId !== '') {
      const idList = Number(patch.bypassListId);
      if (!Number.isInteger(idList) || !(await _listeAppartientA(idList, alanyaID))) {
        return res.status(400).json({
          error: 'Liste de contacts introuvable',
          code: 'BYPASS_LIST_NOT_FOUND',
        });
      }
    }

    // Les plages AVANT le créneau : si elles sont refusées (jour hors bornes,
    // horaire illisible, plus de trois dans la journée), rien d'autre ne doit
    // avoir bougé. L'inverse laisserait un compte dont les plages sont armées
    // mais vides — c'est-à-dire un répondeur qui ne se déclenche jamais, sans
    // que rien à l'écran ne l'explique.
    if (plages != null) await replaceSlots(alanyaID, plages);

    const next = Object.keys(patch).length > 0
      ? await upsertUserVoicemailSchedule(alanyaID, patch)
      : await loadUserVoicemailSchedule(alanyaID);
    const payload = _formatSchedule(next);

    // Aux autres appareils du même compte : la planification est par compte,
    // le bandeau est par appareil.
    emitToUser(req.app.get('io'), alanyaID, 'voicemail_schedule_updated', payload);

    res.json(payload);
  } catch (error) {
    const status = /invalide|doit être/i.test(error.message) ? 400 : 500;
    console.error('[VoicemailSchedule] patch error:', error.message);
    res.status(status).json({ error: error.message });
  }
};

module.exports = {
  getVoicemailSchedule,
  patchVoicemailSchedule,
  _formatSchedule,
  _normalizePatch,
};
