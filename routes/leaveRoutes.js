const express = require('express');
const ctrl = require('../controllers/leaveController');

const router = express.Router();

router.get('/', ctrl.getLeaves);
router.post('/', ctrl.createLeave);
router.put('/:id', ctrl.updateLeave);
router.delete('/:id', ctrl.deleteLeave);

module.exports = router;
