const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getUserById, getUserByPhone, searchUsers, blockUser, unblockUser, getBlockStatus } = require('../controllers/userController');

router.get('/search',       auth, searchUsers);
router.get('/phone/:phone', auth, getUserByPhone);
router.get('/:id',          auth, getUserById);
router.get('/:id/block',    auth, getBlockStatus);
router.post('/:id/block',   auth, blockUser);
router.delete('/:id/block', auth, unblockUser);

module.exports = router;