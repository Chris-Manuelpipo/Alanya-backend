// Usage : node scripts/inspect-messages.js [conversationID] [limit]
// Affiche les derniers messages d'une conversation tels que stockés en base,
// pour vérifier pendant les tests que le chiffrement E2EE est bien respecté :
// - `content` doit être NULL pour tout message chiffré (texte ou média)
// - `ciphertext` doit être non-NULL et illisible (affiché en aperçu hex)
// - `clientId` doit être unique par message (pas de doublon en cas de retry)
const mysql = require('mysql2/promise');
require('dotenv').config();

const conversationID = process.argv[2] ? Number(process.argv[2]) : null;
const limit = process.argv[3] ? Number(process.argv[3]) : 15;

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  const where = conversationID ? 'WHERE conversationID = ?' : '';
  const params = conversationID ? [conversationID] : [];

  // `limit` est validé (Number(...) ci-dessus) avant d'être inliné : LIMIT ne
  // supporte pas un paramètre lié avec `execute` sur certaines versions de mysql2.
  const [rows] = await conn.execute(
    `SELECT msgID, clientId, senderID, conversationID, content, ciphertext,
            mediaUrl, mediaName, status, sendAt
     FROM message
     ${where}
     ORDER BY msgID DESC
     LIMIT ${Number.isInteger(limit) && limit > 0 ? limit : 15}`,
    params
  );

  for (const r of rows.reverse()) {
    console.log({
      msgID: r.msgID,
      clientId: r.clientId,
      conv: r.conversationID,
      sender: r.senderID,
      content: r.content, // doit être null si chiffré
      ciphertext: r.ciphertext ? `<${r.ciphertext.length} octets> ${r.ciphertext.toString('hex').slice(0, 24)}...` : null,
      mediaUrl: r.mediaUrl,   // doit être null pour un média E2EE
      mediaName: r.mediaName, // idem
      status: r.status,
      sendAt: r.sendAt,
    });
  }

  await conn.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
