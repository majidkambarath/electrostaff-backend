const express = require('express');
const ctrl = require('../controllers/payrollController');

const router = express.Router();

router.get('/', ctrl.getPayrollRuns);
router.get('/preview', ctrl.previewPayroll);
router.post('/', ctrl.createPayroll);
router.get('/:id', ctrl.getPayrollRun);
router.put('/:id/mark-paid', ctrl.markPayrollPaid);
router.delete('/:id', ctrl.deletePayrollRun);

module.exports = router;
