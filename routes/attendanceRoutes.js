const express = require('express');
const ctrl = require('../controllers/attendanceController');

const router = express.Router();

router.get('/', ctrl.getAttendance);
router.post('/', ctrl.markAttendance);
router.post('/bulk', ctrl.bulkMarkAttendance);
router.get('/staff/:staffId', ctrl.getStaffAttendance);

module.exports = router;
