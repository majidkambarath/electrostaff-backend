const express = require('express');
const ctrl = require('../controllers/reportController');

const router = express.Router();

router.get('/summary', ctrl.getSummary);
router.get('/muster', ctrl.getMuster);

module.exports = router;
