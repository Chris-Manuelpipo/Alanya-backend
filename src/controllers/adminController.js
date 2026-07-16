// Contrôleur admin  
module.exports = {
  ...require('./admin/auth'),
  ...require('./admin/stats'),
  ...require('./admin/analytics'),
  ...require('./admin/users'),
  ...require('./admin/userCreate'),
  ...require('./admin/reservedAlanyaPhone'),
  ...require('./admin/media'),
  ...require('./admin/groups'),
  ...require('./admin/meetings'),
  ...require('./admin/settings'),
  ...require('./admin/profile'),
};
