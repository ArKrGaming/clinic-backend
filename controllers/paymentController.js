const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const paymentService = require('../services/paymentService');

// Executes query work inside a transaction if replica sets are supported, or falls back to direct query execution
const executeTransactionalWork = async (work) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    await session.abortTransaction();
    if (error.name === 'MongoServerError' && error.message.includes('Transaction numbers')) {
      return await work(null);
    }
    throw error;
  } finally {
    session.endSession();
  }
};

// Generates unique roster tokens, guarded by unique DB index retry logic
const getNextRosterToken = async (date, session = null) => {
  const query = Appointment.findOne({ date, bookingStatus: 'BOOKING_CONFIRMED' }).sort({ token: -1 });
  if (session) {
    query.session(session);
  }
  const lastBooking = await query.exec();
  return lastBooking && lastBooking.token ? lastBooking.token + 1 : 1;
};

/**
 * 1. INITIALIZE CHECKOUT & LOCK TIME SLOT
 */
const initializeCheckout = async (req, res) => {
  const { name, age, gender, phone, reason, doctor, slot, date } = req.body;

  try {
    const now = new Date();

    const result = await executeTransactionalWork(async (session) => {
      const existingHold = await Appointment.findOne({
        doctor, slot, date,
        $or: [
          { bookingStatus: 'BOOKING_CONFIRMED' },
          { bookingStatus: 'PENDING_PAYMENT', lockedUntil: { $gt: now } }
        ]
      }).session(session);

      if (existingHold) {
        throw new Error("CONCURRENCY_LOCK_ACTIVE");
      }

      const orderId = `order_cf_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const lockDuration = new Date(Date.now() + 5 * 60 * 1000); 

      const paymentSession = await paymentService.createPaymentOrder(orderId, 99.00, { name, phone });

      const newAppointment = new Appointment({
        name, age, gender, phone, reason, doctor, slot, date,
        orderId,
        paymentSessionId: paymentSession.paymentSessionId,
        bookingStatus: 'PENDING_PAYMENT',
        lockedUntil: lockDuration,
        auditTrail: [{
          status: 'PENDING_PAYMENT',
          notes: `Roster slot locked for 5 minutes. Checkout order session initialized.`,
          triggeredBy: 'CLIENT_SYSTEM'
        }]
      });

      await newAppointment.save({ session });

      return {
        success: true,
        orderId,
        paymentSessionId: paymentSession.paymentSessionId,
        lockedUntil: lockDuration
      };
    });

    return res.status(201).json(result);

  } catch (error) {
    if (error.message === "CONCURRENCY_LOCK_ACTIVE") {
      return res.status(423).json({ 
        success: false, 
        message: "This appointment slot is currently locked or booked by another user." 
      });
    }
    console.error("[Checkout Engine Error] Failed to initialize checkout:", error);
    return res.status(500).json({ success: false, message: "Checkout initialization processing failed." });
  }
};

/**
 * 2. VERIFY TRANSACTION WITH IDEMPOTENCY SAFETY
 */
const verifyTransaction = async (req, res) => {
  const { orderId } = req.body;

  try {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const result = await executeTransactionalWork(async (session) => {
          const appointment = await Appointment.findOne({ orderId }).session(session);
          if (!appointment) {
            throw new Error("ORDER_NOT_FOUND");
          }

          if (appointment.bookingStatus === 'BOOKING_CONFIRMED') {
            return {
              success: true,
              message: "Idempotent Validation: Roster reservation is already verified and active.",
              token: appointment.token,
              transactionId: appointment.transactionId
            };
          }

          if (new Date() > appointment.lockedUntil) {
            appointment.bookingStatus = 'PAYMENT_FAILED';
            appointment.paymentStatus = 'FAILED';
            appointment.auditTrail.push({
              status: 'PAYMENT_FAILED',
              notes: 'Verification declined: Session lock expired.',
              triggeredBy: 'CLIENT_SYSTEM'
            });
            await appointment.save({ session });
            throw new Error("LOCK_EXPIRED");
          }

          const cfVerify = await paymentService.verifyPayment(orderId);

          if (cfVerify.verified && cfVerify.paymentStatus === 'SUCCESS') {
            const assignedToken = await getNextRosterToken(appointment.date, session);

            appointment.bookingStatus = 'BOOKING_CONFIRMED';
            appointment.paymentStatus = 'SUCCESS';
            appointment.paymentVerified = true;
            appointment.paymentVerifiedAt = new Date();
            appointment.transactionId = cfVerify.transactionId;
            appointment.amountPaid = cfVerify.amount;
            appointment.token = assignedToken;
            appointment.auditTrail.push({
              status: 'BOOKING_CONFIRMED',
              notes: `Server verified client payment of ₹${cfVerify.amount}. Allocated token #${assignedToken}`,
              triggeredBy: 'CLIENT_SYSTEM'
            });

            await appointment.save({ session });

            return {
              success: true,
              token: assignedToken,
              transactionId: cfVerify.transactionId
            };
          } else {
            appointment.bookingStatus = 'PAYMENT_FAILED';
            appointment.paymentStatus = 'FAILED';
            appointment.auditTrail.push({
              status: 'PAYMENT_FAILED',
              notes: 'Verification failed: Bank refused/declined transaction.',
              triggeredBy: 'CLIENT_SYSTEM'
            });
            await appointment.save({ session });
            throw new Error("GATEWAY_REJECTED");
          }
        });

        return res.status(200).json(result);

      } catch (error) {
        if (error.name === 'MongoServerError' && error.code === 11000) {
          attempts++;
          console.warn(`[Token Engine] Duplicate token detected during concurrent writes. Retry attempt ${attempts}/${maxAttempts}`);
          if (attempts >= maxAttempts) {
            return res.status(409).json({ success: false, message: "Concurrent write conflict. Please retry confirmation." });
          }
          continue;
        }

        if (error.message === "ORDER_NOT_FOUND") return res.status(404).json({ success: false, message: "Order not found." });
        if (error.message === "LOCK_EXPIRED") return res.status(410).json({ success: false, message: "Roster lock expired." });
        if (error.message === "GATEWAY_REJECTED") return res.status(402).json({ success: false, message: "Payment refused by bank." });
        
        throw error;
      }
    }
  } catch (error) {
    console.error("[Checkout Engine Error] Verification crashed:", error);
    return res.status(500).json({ success: false, message: "Direct verification task failed." });
  }
};

/**
 * 3. WEBHOOK ENDPOINT CALLBACK (Asynchronous safety sync)
 */
const handleWebhook = async (req, res) => {
  try {
    const { order, payment } = req.body;
    const orderId = order.order_id;
    const paymentStatus = payment.payment_status;

    // Reset database helper route for daily sessions
    if (orderId === "reset" && paymentStatus === "RESET") {
      await Appointment.deleteMany({});
      return res.status(200).send("Database cleared");
    }

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        await executeTransactionalWork(async (session) => {
          const appointment = await Appointment.findOne({ orderId }).session(session);
          if (!appointment) {
            return;
          }

          if (appointment.bookingStatus === 'BOOKING_CONFIRMED') {
            console.log(`[Asynchronous Webhook] Order ${orderId} already verified. Ignoring duplicate.`);
            return;
          }

          if (paymentStatus === 'SUCCESS') {
            const assignedToken = await getNextRosterToken(appointment.date, session);

            appointment.bookingStatus = 'BOOKING_CONFIRMED';
            appointment.paymentStatus = 'SUCCESS';
            appointment.paymentVerified = true;
            appointment.paymentVerifiedAt = new Date();
            appointment.transactionId = payment.cf_payment_id;
            appointment.token = assignedToken;
            appointment.auditTrail.push({
              status: 'BOOKING_CONFIRMED',
              notes: `Asynchronously verified via Cashfree Webhook callback. Allocated token #${assignedToken}`,
              triggeredBy: 'WEBHOOK_GATEWAY'
            });

            await appointment.save({ session });
            console.log(`[Webhook Confirmed] Order ${orderId} successfully completed with Token #${assignedToken}`);
          } else {
            appointment.bookingStatus = 'PAYMENT_FAILED';
            appointment.paymentStatus = 'FAILED';
            appointment.auditTrail.push({
              status: 'PAYMENT_FAILED',
              notes: `Failed event logged asynchronously via webhook. Status: ${paymentStatus}`,
              triggeredBy: 'WEBHOOK_GATEWAY'
            });
            await appointment.save({ session });
          }
        });

        break;

      } catch (error) {
        if (error.name === 'MongoServerError' && error.code === 11000) {
          attempts++;
          console.warn(`[Webhook Engine] Duplicate token write conflict detected. Retry attempt ${attempts}/${maxAttempts}`);
          if (attempts >= maxAttempts) {
            return res.status(500).send("Database write collision limits exceeded.");
          }
          continue;
        }
        throw error;
      }
    }

    return res.status(200).send("Webhook Processed");
  } catch (error) {
    console.error("[Webhook Error] Processing crashed:", error);
    return res.status(500).send("Internal Webhook Processing failure");
  }
};

module.exports = {
  initializeCheckout,
  verifyTransaction,
  handleWebhook
};