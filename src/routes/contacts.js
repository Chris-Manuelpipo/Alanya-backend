const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const {
  getPreferredContacts,
  addPreferredContact,
  removePreferredContact,
  checkIsContact,
} = require('../controllers/preferredContactController');
 
router.get('/check/:id', auth, checkIsContact);
router.get('/',          auth, getPreferredContacts);
router.post('/:id',      auth, addPreferredContact);
router.delete('/:id',    auth, removePreferredContact);

module.exports = router;