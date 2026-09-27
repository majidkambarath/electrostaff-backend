const express = require('express');
const ctrl = require('../controllers/siteController');

const router = express.Router();

router.get('/', ctrl.getSites);
router.post('/', ctrl.createSite);
router.get('/:id', ctrl.getSiteById);
router.put('/:id', ctrl.updateSite);
router.delete('/:id', ctrl.deleteSite);
router.get('/:id/progress', ctrl.getSiteProgress);
router.get('/:id/finance', ctrl.getSiteFinance);
router.get('/:id/staff', ctrl.getSiteStaff);
router.post('/:id/assign', ctrl.assignStaff);
router.delete('/:id/assign/:staffId', ctrl.unassignStaff);

module.exports = router;
