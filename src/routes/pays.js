const express = require('express');
const router = express.Router();
const pool = require('../config/db');

/**
 * @swagger
 * /api/pays:
 *   get:
 *     summary: Liste des pays
 *     tags: [Pays]
 *     responses:
 *       200:
 *         description: Liste des pays triés par nom
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   idPays:
 *                     type: integer
 *                   libelle:
 *                     type: string
 *                   prefix:
 *                     type: string
 *                   timeZone:
 *                     type: string
 *                   decalageHoraire:
 *                     type: string
 */
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT idPays, libelle, prefix, timeZone, decalageHoraire FROM pays ORDER BY libelle');
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
