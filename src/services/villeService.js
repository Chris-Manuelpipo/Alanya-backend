const pool = require('../config/db');

const normalizeCity = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

async function lookupVilleId(idPays, cityLabel) {
  if (!idPays || !cityLabel) return null;
  const norm = normalizeCity(cityLabel);
  const [rows] = await pool.execute(
    'SELECT idVille FROM ville WHERE idPays = ? AND libelle_norm = ? LIMIT 1',
    [idPays, norm],
  );
  return rows.length ? rows[0].idVille : null;
}

async function listVilles(idPays, search = '', limit = 30) {
  const params = [idPays];
  let where = 'idPays = ?';
  if (search) {
    where += ' AND libelle LIKE ?';
    params.push(`%${search}%`);
  }
  const [rows] = await pool.execute(
    `SELECT idVille, libelle, idPays FROM ville WHERE ${where} ORDER BY libelle ASC LIMIT ${Math.min(100, limit)}`,
    params,
  );
  return rows;
}

module.exports = { normalizeCity, lookupVilleId, listVilles };
