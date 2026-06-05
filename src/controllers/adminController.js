// Contrôleur admin — barrel.
// L'implémentation est découpée par domaine dans ./admin/* (auth, stats,
// analytics, users, media, groups, meetings, settings) + helpers partagés.
// Ce fichier ne fait que ré-exporter, pour préserver l'API consommée par
// src/routes/admin.js (`require('../controllers/adminController')`).

module.exports = {
  ...require('./admin/auth'),
  ...require('./admin/stats'),
  ...require('./admin/analytics'),
  ...require('./admin/users'),
  ...require('./admin/media'),
  ...require('./admin/groups'),
  ...require('./admin/meetings'),
  ...require('./admin/settings'),
};
