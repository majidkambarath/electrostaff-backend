const express = require('express');
const ctrl = require('../controllers/staffController');

const router = express.Router();

router.get('/', ctrl.getAllStaff);
router.post('/', ctrl.createStaff);
router.get('/:id', ctrl.getStaffById);
router.put('/:id', ctrl.updateStaff);
router.delete('/:id', ctrl.deleteStaff);

module.exports = router;
