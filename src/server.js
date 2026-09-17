require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initFirebaseAdmin, EXPECTED_PROJECT_ID } = require('./firebase-admin');
const notificationRoutes = require('./routes/notification-routes');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// 1. Configure restricted CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, Postman) in dev
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Blocked by CORS policy: Origin not allowed.'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-dev-secret'],
  })
);

// 2. Request body parsing with strict size limit
app.use(express.json({ limit: '100kb' }));

// 3. Mount Routes
app.use('/', notificationRoutes);

// 4. Safe 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
  });
});

// 5. Safe global error handler (never expose stack traces or server credentials)
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message || 'Unknown error');
  res.status(err.status || 500).json({
    success: false,
    error: NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// 6. Start server
const server = app.listen(PORT, () => {
  console.log(`\n=============================================================`);
  console.log(`[Server] CampusRide Notification Server running on port ${PORT}`);
  console.log(`[Server] Environment: ${NODE_ENV}`);
  console.log(`[Server] Target Firebase Project: ${EXPECTED_PROJECT_ID}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/health`);
  console.log(`=============================================================\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] Shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

module.exports = app;

