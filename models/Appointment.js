const mongoose = require('mongoose');

const AuditEventSchema = new mongoose.Schema({
  status: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    required: true
  },
  triggeredBy: {
    type: String,
    enum: ['CLIENT_SYSTEM', 'WEBHOOK_GATEWAY', 'CRON_CLEANUP', 'STAFF_CONSOLE'],
    required: true
  }
}, { _id: false });

const AppointmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  age: {
    type: Number,
    required: true,
    min: 1,
    max: 120
  },
  gender: {
    type: String,
    required: true,
    enum: ['Male', 'Female', 'Other']
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  reason: {
    type: String,
    trim: true,
    default: 'No symptoms specified'
  },
  doctor: {
    type: String,
    required: true
  },
  slot: {
    type: String,
    required: true
  },
  date: {
    type: String,
    required: true
  }, 
  token: {
    type: Number,
    sparse: true,
    unique: true
  }, 

  bookingStatus: {
    type: String,
    required: true,
    enum: [
      'PENDING_PAYMENT',
      'PAYMENT_PROCESSING',
      'PAYMENT_VERIFIED',
      'BOOKING_CONFIRMED',
      'PAYMENT_FAILED',
      'PAYMENT_CANCELLED'
    ],
    default: 'PENDING_PAYMENT'
  },

  paymentStatus: {
    type: String,
    enum: ['PENDING', 'SUCCESS', 'FAILED'],
    default: 'PENDING'
  },
  orderId: {
    type: String,
    unique: true,
    required: true
  },
  paymentSessionId: {
    type: String
  },
  transactionId: {
    type: String
  },
  paymentGateway: {
    type: String,
    default: 'CASHFREE'
  },
  amountPaid: {
    type: Number,
    default: 99.00
  },
  paymentVerified: {
    type: Boolean,
    default: false
  },
  paymentVerifiedAt: {
    type: Date
  },

  lockedUntil: {
    type: Date,
    required: true
  },

  auditTrail: [AuditEventSchema]
}, { timestamps: true });

// Redundant index on orderId has been removed to resolve the Mongoose index warning

// Keep the compound partial index: Crucial for preventing concurrent double-booking of confirmed slots
AppointmentSchema.index(
  { doctor: 1, slot: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: { bookingStatus: 'BOOKING_CONFIRMED' }
  }
);

module.exports = mongoose.model('Appointment', AppointmentSchema);