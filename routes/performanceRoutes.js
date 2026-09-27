const express = require('express');
const ctrl = require('../controllers/performanceController');

const router = express.Router();

router.get('/', ctrl.getPerformance);
router.post('/', ctrl.createOrUpdatePerformance);
router.delete('/:id', ctrl.deletePerformance);

module.exports = router;
