const express = require('express');
const ctrl = require('../controllers/paymentController');

const router = express.Router();

router.get('/', ctrl.getPayments);
router.get('/preview', ctrl.previewPayment);
router.get('/outstanding', ctrl.getOutstanding);
router.post('/', ctrl.createPayment);
router.get('/:id', ctrl.getPaymentById);
router.put('/:id/mark-paid', ctrl.markPaid);
router.delete('/:id', ctrl.deletePayment);

module.exports = router;
