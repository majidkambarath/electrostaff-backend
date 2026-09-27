const express = require('express');
const ctrl = require('../controllers/expenseController');

const router = express.Router();

router.get('/', ctrl.getExpenses);
router.post('/', ctrl.createExpense);
router.put('/:id', ctrl.updateExpense);
router.delete('/:id', ctrl.deleteExpense);

module.exports = router;
