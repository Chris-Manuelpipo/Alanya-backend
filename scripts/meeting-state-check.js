#!/usr/bin/env node
require('dotenv').config();

const mysql = require('mysql2/promise');

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

async function main() {
  const meetingId = toInt(process.argv[2]);
  if (!meetingId) {
    console.error('Usage: node scripts/meeting-state-check.js <meetingId>');
    process.exit(1);
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
  });

  try {
    const [meetings] = await pool.execute(
      'SELECT idMeeting, idOrganiser, objet, room, isEnd, type_media, start_time, duree FROM meeting WHERE idMeeting = ?',
      [meetingId]
    );

    if (meetings.length === 0) {
      console.error(`Meeting ${meetingId} introuvable`);
      process.exit(2);
    }

    const [participants] = await pool.execute(
      `SELECT IDparticipant, status, connecte, start_time, duree
       FROM participant
       WHERE idMeeting = ?
       ORDER BY IDparticipant ASC`,
      [meetingId]
    );

    console.log('=== MEETING ===');
    console.table(meetings);
    console.log('=== PARTICIPANTS ===');
    console.table(participants);

    const connectedCount = participants.filter((p) => Number(p.connecte) === 1).length;
    console.log(`Connected participants: ${connectedCount}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Erreur:', err.message);
  process.exit(3);
});
