const express = require('express');
const {
  admin,
  getUserDeviceTokens,
  sendPushNotification,
  maskToken,
} = require('../firebase-admin');

const router = express.Router();

/**
 * Root Server Status Endpoint
 * GET /
 */
router.get('/', (req, res) => {
  const isFirebaseReady = admin.apps.length > 0;
  res.status(200).json({
    status: 'ok',
    service: 'campusride-notification-server',
    firebase: isFirebaseReady ? 'connected' : 'uninitialized',
    message: 'CampusRide Notification Server is active',
  });
});

/**
 * Health Check Endpoint
 * GET /health
 */
router.get('/health', (req, res) => {
  const isFirebaseReady = admin.apps.length > 0;
  res.status(200).json({
    status: 'ok',
    service: 'campusride-notification-server',
    firebase: isFirebaseReady ? 'connected' : 'uninitialized',
  });
});

/**
 * Development-Only Test Notification Endpoint
 * POST /test-notification
 * 
 * Body: { "token": "<FCM_REGISTRATION_TOKEN>" }
 * Headers (optional in dev, required if DEV_TEST_SECRET configured):
 *   x-dev-secret: <DEV_TEST_SECRET>
 */
router.post('/test-notification', async (req, res) => {
  // 1. Guard against public exploitation
  const isDev = process.env.NODE_ENV !== 'production';
  const configuredSecret = process.env.DEV_TEST_SECRET;
  const providedSecret = req.headers['x-dev-secret'];

  if (!isDev && (!configuredSecret || providedSecret !== configuredSecret)) {
    return res.status(403).json({
      success: false,
      error: 'Access denied: Test endpoint is restricted to local development.',
    });
  }

  // 2. Validate token input
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Invalid request: "token" string is required in request body.',
    });
  }

  const cleanToken = token.trim();
  const masked = maskToken(cleanToken);
  console.log(`[API] Test notification requested for token [${masked}]`);

  // 3. Dispatch test notification using Firebase Admin SDK
  try {
    const result = await sendPushNotification({
      token: cleanToken,
      title: 'CampusRide Test',
      body: 'Your CampusRide notifications are working!',
      data: {
        type: 'test_notification',
        timestamp: Date.now().toString(),
      },
    });

    if (result.success) {
      return res.status(200).json({
        success: true,
        message: 'Test notification sent',
        messageId: result.messageId,
      });
    } else {
      return res.status(502).json({
        success: false,
        message: 'Failed to deliver notification via FCM',
        error: result.error,
      });
    }
  } catch (error) {
    console.error('[API] Unexpected error in /test-notification:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error while dispatching notification',
    });
  }
});

/**
 * Production Firebase Authentication Middleware
 * Validates 'Authorization: Bearer <ID_TOKEN>'
 */
async function authenticateFirebaseUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Missing or invalid Bearer token in Authorization header.',
    });
  }

  const idToken = authHeader.split('Bearer ')[1].trim();
  if (!idToken) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Empty token provided.',
    });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified,
    };
    next();
  } catch (error) {
    console.error('[Auth] Token verification failed:', error.code || error.message);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or expired Firebase authentication token.',
    });
  }
}

/**
 * Production Endpoint: Send notification to a student's devices
 * POST /send-to-user
 * 
 * Headers: Authorization: Bearer <ID_TOKEN>
 * Body: { "recipientUid": "...", "title": "...", "body": "...", "data": {...} }
 */
router.post('/send-to-user', authenticateFirebaseUser, async (req, res) => {
  const senderUid = req.user.uid;
  const { recipientUid, title, body, data } = req.body;

  if (!recipientUid || typeof recipientUid !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Invalid request: "recipientUid" is required.',
    });
  }

  // Prevent self-notification abuse
  if (senderUid === recipientUid) {
    return res.status(400).json({
      success: false,
      error: 'Cannot send push notification to own UID.',
    });
  }

  if (!title || !body) {
    return res.status(400).json({
      success: false,
      error: 'Invalid request: "title" and "body" are required.',
    });
  }

  try {
    // 1. Fetch recipient's registered device tokens from Firestore
    const devices = await getUserDeviceTokens(recipientUid);

    if (devices.length === 0) {
      console.log(`[FCM] No registered device tokens found for recipient UID: ${recipientUid}`);
      return res.status(200).json({
        success: true,
        sentCount: 0,
        message: 'No registered devices found for recipient.',
      });
    }

    console.log(`[FCM] Dispatching notification to ${devices.length} devices for recipient UID: ${recipientUid}`);

    // 2. Dispatch notification to each device token
    const results = await Promise.all(
      devices.map(device =>
        sendPushNotification({
          token: device.token,
          title: String(title).slice(0, 100),
          body: String(body).slice(0, 250),
          data: data || {},
          userId: recipientUid,
        })
      )
    );

    const successCount = results.filter(r => r.success).length;
    return res.status(200).json({
      success: true,
      sentCount: successCount,
      totalDevices: devices.length,
    });
  } catch (error) {
    console.error('[API] Error in /send-to-user:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error while processing notification request',
    });
  }
});

/**
 * Ride Join Notification Endpoint
 * POST /notify-ride-join
 * 
 * Body: { "rideId": "...", "participantId": "..." }
 * Headers:
 *   Authorization: Bearer <ID_TOKEN> (or x-dev-secret in dev)
 */
router.post('/notify-ride-join', async (req, res) => {
  // 1. Authenticate request (Bearer Firebase ID token or dev secret)
  const configuredSecret = process.env.DEV_TEST_SECRET;
  const providedSecret = req.headers['x-dev-secret'];
  const authHeader = req.headers.authorization;

  let authenticatedUid = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.split('Bearer ')[1].trim();
    if (idToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        authenticatedUid = decoded.uid;
      } catch (err) {
        console.warn('[Auth] ID token verification failed in /notify-ride-join:', err.code || err.message);
      }
    }
  }

  const isDevSecretValid = configuredSecret && providedSecret === configuredSecret;

  if (!authenticatedUid && !isDevSecretValid) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Valid Firebase ID token or dev secret required.',
    });
  }

  // 2. Validate input parameters
  const { rideId, participantId } = req.body;
  if (!rideId || typeof rideId !== 'string' || !participantId || typeof participantId !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Invalid request: "rideId" and "participantId" strings are required.',
    });
  }

  // If ID token was provided, enforce that caller is the participant (no impersonation)
  if (authenticatedUid && authenticatedUid !== participantId && !isDevSecretValid) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: Authenticated UID does not match participantId.',
    });
  }

  try {
    const db = admin.firestore();

    // 3. Verify ride exists
    const rideDoc = await db.collection('rides').doc(rideId).get();
    if (!rideDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Ride not found.',
      });
    }

    const rideData = rideDoc.data() || {};
    const creatorId = rideData.creatorId;
    const destination = rideData.destination || 'destination';

    // 4. Verify participant is actually in rides/{rideId}/participants/{participantId}
    const participantDoc = await db
      .collection('rides')
      .doc(rideId)
      .collection('participants')
      .doc(participantId)
      .get();

    if (!participantDoc.exists) {
      return res.status(400).json({
        success: false,
        error: 'Participant is not registered in this ride.',
      });
    }

    // 5. Self-notification check (Requirement 9)
    if (participantId === creatorId) {
      console.log(`[FCM] Joiner is ride creator (${creatorId}). Self-notification suppressed.`);
      return res.status(200).json({
        success: true,
        message: 'Self-notification suppressed.',
      });
    }

    // 6. Idempotency / Duplicate prevention check (Requirement 7)
    const existingNotifSnap = await db
      .collection('users')
      .doc(creatorId)
      .collection('notifications')
      .where('type', '==', 'ride_joined')
      .where('rideId', '==', rideId)
      .where('participantId', '==', participantId)
      .limit(1)
      .get();

    if (!existingNotifSnap.empty) {
      console.log(`[FCM] Duplicate join notification suppressed for ride ${rideId} and participant ${participantId}`);
      return res.status(200).json({
        success: true,
        message: 'Duplicate join notification suppressed.',
        duplicate: true,
      });
    }

    // 7. Retrieve participant profile name
    let joinerName = 'A student';
    try {
      const userDoc = await db.collection('users').doc(participantId).get();
      if (userDoc.exists) {
        const uData = userDoc.data() || {};
        joinerName = uData.name || uData.email || 'A student';
      }
    } catch (_) {}

    const notifTitle = 'New passenger joined';
    const notifBody = `${joinerName} joined your ride to ${destination}.`;

    // 8. Create In-App Notification document for creator
    const notifRef = db.collection('users').doc(creatorId).collection('notifications').doc();
    await notifRef.set({
      notificationId: notifRef.id,
      userId: creatorId,
      title: notifTitle,
      body: notifBody,
      type: 'ride_joined',
      rideId: rideId,
      participantId: participantId,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[FCM] In-app notification created for creator ${creatorId}`);

    // 9. Multi-device FCM Push Notification dispatch
    const devices = await getUserDeviceTokens(creatorId);
    if (devices.length === 0) {
      console.log(`[FCM] Creator [${creatorId}] has 0 active device tokens`);
      return res.status(200).json({
        success: true,
        sentCount: 0,
        totalDevices: 0,
        message: 'In-app notification created; creator has no registered devices.',
      });
    }

    console.log(`[FCM] Dispatching push notification to ${devices.length} device(s) for creator [${creatorId}]`);
    const results = await Promise.all(
      devices.map(device =>
        sendPushNotification({
          token: device.token,
          title: notifTitle,
          body: notifBody,
          data: {
            type: 'ride_joined',
            rideId: rideId,
          },
          userId: creatorId, // Enables automatic pruning of stale / invalid tokens (Requirement 8)
        })
      )
    );

    const successCount = results.filter(r => r.success).length;
    console.log(`[FCM] Ride join notification delivered to ${successCount}/${devices.length} devices for creator [${creatorId}]`);

    return res.status(200).json({
      success: true,
      sentCount: successCount,
      totalDevices: devices.length,
    });
  } catch (error) {
    console.error('[API] Error in /notify-ride-join:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error while processing ride join notification',
    });
  }
});

module.exports = router;

