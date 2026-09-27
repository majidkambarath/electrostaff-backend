const express = require('express');
const ctrl = require('../controllers/orgController');

const router = express.Router();

router.get('/', ctrl.getOrg);
router.put('/', ctrl.updateOrg);

module.exports = router;
