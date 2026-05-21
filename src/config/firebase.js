// Configuration et initialisation de Firebase Admin SDK pour les notifications push
const admin = require('firebase-admin');

if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT manquant dans .env');
    }

    const serviceAccount = JSON.parse(raw);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log('[Firebase] Admin SDK initialisé avec succès');
  } catch (err) {
    console.error('[Firebase] Échec initialisation:', err.message); 
  }
}

module.exports = admin;