// Contrôleur admin  
module.exports = {
  ...require('./admin/auth'),
  ...require('./admin/stats'),
  ...require('./admin/analytics'),
  ...require('./admin/trips'),
  ...require('./admin/tripRetention'),
  ...require('./admin/users'),
  ...require('./admin/userCreate'),
  ...require('./admin/reservedAlanyaPhone'),
  ...require('./admin/media'),
  ...require('./admin/groups'),
  ...require('./admin/meetings'),
  ...require('./admin/settings'),
  ...require('./admin/profile'),
  ...require('./admin/broadcast'),
  ...require('./admin/villes'),
  ...require('./admin/export'),
};
