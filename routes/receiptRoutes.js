const express = require('express');
const ctrl = require('../controllers/receiptController');

const router = express.Router();

router.get('/', ctrl.getReceipts);
router.post('/', ctrl.createReceipt);
router.delete('/:id', ctrl.deleteReceipt);

module.exports = router;
