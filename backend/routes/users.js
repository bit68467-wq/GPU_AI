const express = require('express');
const router = express.Router();
const usersCtrl = require('../controllers/usersController');

// POST /api/users/register
router.post('/register', usersCtrl.register);

// POST /api/users/login
router.post('/login', usersCtrl.login);

// GET /api/users/uid/:uid
router.get('/uid/:uid', usersCtrl.findByUid);

module.exports = router;