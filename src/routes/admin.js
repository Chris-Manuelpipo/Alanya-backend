const express = require('express');
const router = express.Router();
const { adminAuth, superAdminAuth } = require('../middleware/adminAuth');
const {
  adminLogin,
  getStats,
  getUsers,
  getUserById,
  getUserActivity,
  getUserLogins,
  banUser,
  unbanUser,
  setAccountType,
  deleteUser,
} = require('../controllers/adminController');

// ── Auth (publique) ────────────────────────────────────────────
router.post('/auth/login', adminLogin);

// ── Stats & users (admin & super-admin) ────────────────────────
router.get('/stats',                       adminAuth, getStats);
router.get('/users',                       adminAuth, getUsers);
router.get('/users/:id',                   adminAuth, getUserById);
router.get('/users/:id/activity',          adminAuth, getUserActivity);
router.get('/users/:id/logins',            adminAuth, getUserLogins);
router.post('/users/:id/ban',              adminAuth, banUser);
router.delete('/users/:id/ban',            adminAuth, unbanUser);

// ── Super-admin only ───────────────────────────────────────────
router.put('/users/:id/role',              adminAuth, superAdminAuth, setAccountType);
router.delete('/users/:id',                adminAuth, superAdminAuth, deleteUser);

module.exports = router;
