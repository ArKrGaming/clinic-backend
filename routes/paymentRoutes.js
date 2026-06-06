const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

router.post('/initialize-checkout', paymentController.initializeCheckout);
router.post('/verify-transaction', paymentController.verifyTransaction);
router.post('/webhook', paymentController.handleWebhook);

module.exports = router;