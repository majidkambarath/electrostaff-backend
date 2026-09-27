const express = require('express');
const ctrl = require('../controllers/advanceController');

const router = express.Router();

router.get('/', ctrl.getAdvances);
router.get('/balances', ctrl.getBalances);
router.post('/', ctrl.createAdvance);
router.delete('/:id', ctrl.deleteAdvance);

module.exports = router;
