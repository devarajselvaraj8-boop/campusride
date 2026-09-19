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

    const notifTitle = 'New friend joined';
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

/**
 * Ride Leave Notification Endpoint
 * POST /notify-ride-leave
 * 
 * Body: { "rideId": "...", "participantId": "..." }
 * Headers:
 *   Authorization: Bearer <ID_TOKEN> (or x-dev-secret in dev)
 */
router.post('/notify-ride-leave', async (req, res) => {
  // 1. Authenticate request (Bearer Firebase ID token or dev secret)
  const configuredSecret = process.env.DEV_TEST_SECRET || 'campusride_dev_test_secret_key_change_me';
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
        console.warn('[Auth] ID token verification failed in /notify-ride-leave:', err.code || err.message);
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

  // Enforce that caller is the participant (no impersonation) unless using dev secret
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

    // 4. Do not notify if participant is the creator (creators cancel, not leave)
    if (participantId === creatorId) {
      console.log(`[FCM] Leaving user is ride creator (${creatorId}). Self-notification suppressed.`);
      return res.status(200).json({
        success: true,
        message: 'Creator leave self-notification suppressed.',
      });
    }

    // 5. Verify the leave actually happened: participant must NOT be currently in participants collection
    const participantDoc = await db
      .collection('rides')
      .doc(rideId)
      .collection('participants')
      .doc(participantId)
      .get();

    if (participantDoc.exists) {
      return res.status(400).json({
        success: false,
        error: 'Participant has not left this ride (participant document still exists).',
      });
    }

    // 6. Secure verification: Verify that participant genuinely joined this ride previously
    // Distinguishes "participant genuinely left" from "participant never existed"
    const leaveEventRef = db
      .collection('rides')
      .doc(rideId)
      .collection('leave_events')
      .doc(participantId);
    const leaveEventDoc = await leaveEventRef.get();

    if (!leaveEventDoc.exists) {
      const priorJoinNotifSnap = await db
        .collection('users')
        .doc(creatorId)
        .collection('notifications')
        .where('type', '==', 'ride_joined')
        .where('rideId', '==', rideId)
        .where('participantId', '==', participantId)
        .limit(1)
        .get();

      if (priorJoinNotifSnap.empty) {
        return res.status(400).json({
          success: false,
          error: 'Verification failed: Participant was not a member of this ride.',
        });
      }
    }

    // 7. Duplicate prevention / Idempotency check:
    // Check if a ride_left notification or leave_event was already created for this ride and participant
    const existingNotifSnap = await db
      .collection('users')
      .doc(creatorId)
      .collection('notifications')
      .where('type', '==', 'ride_left')
      .where('rideId', '==', rideId)
      .where('participantId', '==', participantId)
      .limit(1)
      .get();

    if (!existingNotifSnap.empty || leaveEventDoc.exists) {
      console.log(`[FCM] Duplicate leave notification suppressed for ride ${rideId} and participant ${participantId}`);
      return res.status(200).json({
        success: true,
        message: 'Duplicate leave notification suppressed.',
        duplicate: true,
      });
    }

    // Record persistent leave event
    await leaveEventRef.set({
      participantId: participantId,
      rideId: rideId,
      leftAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 8. Retrieve participant profile name
    let leaverName = 'A passenger';
    try {
      const userDoc = await db.collection('users').doc(participantId).get();
      if (userDoc.exists) {
        const uData = userDoc.data() || {};
        leaverName = uData.name || uData.email || 'A passenger';
      }
    } catch (_) {}

    const notifTitle = 'Passenger left your ride';
    const notifBody = `${leaverName} left your ride to ${destination}.`;

    // 8. Create In-App Notification document for creator
    const notifRef = db.collection('users').doc(creatorId).collection('notifications').doc();
    await notifRef.set({
      notificationId: notifRef.id,
      userId: creatorId,
      title: notifTitle,
      body: notifBody,
      type: 'ride_left',
      rideId: rideId,
      participantId: participantId,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[FCM] In-app leave notification created for creator ${creatorId}`);

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

    console.log(`[FCM] Dispatching leave push notification to ${devices.length} device(s) for creator [${creatorId}]`);
    const results = await Promise.all(
      devices.map(device =>
        sendPushNotification({
          token: device.token,
          title: notifTitle,
          body: notifBody,
          data: {
            type: 'ride_left',
            rideId: rideId,
            participantId: participantId,
          },
          userId: creatorId,
        })
      )
    );

    const successCount = results.filter(r => r.success).length;
    console.log(`[FCM] Ride leave notification delivered to ${successCount}/${devices.length} devices for creator [${creatorId}]`);

    return res.status(200).json({
      success: true,
      sentCount: successCount,
      totalDevices: devices.length,
    });
  } catch (error) {
    console.error('[API] Error in /notify-ride-leave:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error while processing ride leave notification',
    });
  }
});

/**
 * Chat Message Notification Endpoint
 * POST /notify-chat-message
 * 
 * Body: { "rideId": "...", "messageId": "...", "senderId": "..." }
 * Headers:
 *   Authorization: Bearer <ID_TOKEN> (or x-dev-secret in dev)
 */
router.post('/notify-chat-message', async (req, res) => {
  // 1. Authenticate request (Bearer Firebase ID token or dev secret)
  const configuredSecret = process.env.DEV_TEST_SECRET || 'campusride_dev_test_secret_key_change_me';
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
        console.warn('[Auth] ID token verification failed in /notify-chat-message:', err.code || err.message);
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
  const { rideId, messageId, senderId } = req.body;
  if (
    !rideId || typeof rideId !== 'string' || !rideId.trim() ||
    !messageId || typeof messageId !== 'string' || !messageId.trim() ||
    !senderId || typeof senderId !== 'string' || !senderId.trim()
  ) {
    return res.status(400).json({
      success: false,
      error: 'Invalid request: "rideId", "messageId", and "senderId" non-empty strings are required.',
    });
  }

  const cleanRideId = rideId.trim();
  const cleanMessageId = messageId.trim();
  const cleanSenderId = senderId.trim();

  // Enforce that caller is the sender (no impersonation) unless using dev secret
  if (authenticatedUid && authenticatedUid !== cleanSenderId && !isDevSecretValid) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: Authenticated UID does not match senderId.',
    });
  }

  try {
    const db = admin.firestore();

    // 3. Verify ride exists and is not cancelled
    const rideDoc = await db.collection('rides').doc(cleanRideId).get();
    if (!rideDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Ride not found.',
      });
    }

    const rideData = rideDoc.data() || {};
    if (rideData.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'Cannot send chat notifications for a cancelled ride.',
      });
    }

    const creatorId = rideData.creatorId;

    // 4. Verify message exists authoritatively in Firestore
    const messageDoc = await db
      .collection('rides')
      .doc(cleanRideId)
      .collection('messages')
      .doc(cleanMessageId)
      .get();

    if (!messageDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Message not found in ride messages.',
      });
    }

    const messageData = messageDoc.data() || {};

    // Verify senderId matches authoritative message author
    if (messageData.senderId !== cleanSenderId) {
      return res.status(400).json({
        success: false,
        error: 'Message author mismatch.',
      });
    }

    const messageText = (messageData.text || '').trim();
    if (!messageText) {
      return res.status(400).json({
        success: false,
        error: 'Message text is empty.',
      });
    }

    // 5. Verify sender is authorized: Must be ride creator or an active joined participant
    const isCreator = cleanSenderId === creatorId;
    let isParticipant = false;

    if (!isCreator) {
      const participantDoc = await db
        .collection('rides')
        .doc(cleanRideId)
        .collection('participants')
        .doc(cleanSenderId)
        .get();

      if (participantDoc.exists && (participantDoc.data() || {}).status === 'joined') {
        isParticipant = true;
      }
    }

    if (!isCreator && !isParticipant) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Sender is not an authorized member of this ride.',
      });
    }

    // 6. Duplicate prevention / Idempotency check:
    // If message already has notificationsDispatched flag, return duplicate response
    if (messageData.notificationsDispatched === true) {
      console.log(`[FCM] Duplicate chat notification suppressed for message ${cleanMessageId}`);
      return res.status(200).json({
        success: true,
        message: 'Duplicate chat notification suppressed.',
        duplicate: true,
      });
    }

    // 7. Determine eligible recipients from current ride members:
    // - Exclude sender
    // - Include ride creator (if not sender)
    // - Include all current active participants with status == 'joined'
    // - Do NOT notify users who have left or are unrelated
    const recipientSet = new Set();

    if (creatorId && creatorId !== cleanSenderId) {
      recipientSet.add(creatorId);
    }

    const participantsSnap = await db
      .collection('rides')
      .doc(cleanRideId)
      .collection('participants')
      .get();

    participantsSnap.forEach(pDoc => {
      const pData = pDoc.data() || {};
      if (pDoc.id !== cleanSenderId && pData.status === 'joined') {
        recipientSet.add(pDoc.id);
      }
    });

    const recipients = Array.from(recipientSet);

    if (recipients.length === 0) {
      console.log(`[FCM] Chat message ${cleanMessageId} in ride ${cleanRideId} has 0 other members to notify.`);
      await messageDoc.ref.update({ notificationsDispatched: true });
      return res.status(200).json({
        success: true,
        sentCount: 0,
        totalDevices: 0,
        recipientsCount: 0,
        message: 'No other active participants to notify.',
      });
    }

    // 8. Fetch sender's real profile name
    let senderName = 'A student';
    try {
      const userDoc = await db.collection('users').doc(cleanSenderId).get();
      if (userDoc.exists) {
        const uData = userDoc.data() || {};
        senderName = uData.name || uData.email || 'A student';
      }
    } catch (_) {}

    const notifTitle = senderName;
    const notifBody = messageText;

    // 9. Persist In-App Notification and dispatch FCM to each recipient
    let totalSentCount = 0;
    let totalDeviceCount = 0;

    await Promise.all(
      recipients.map(async recipientId => {
        // Create in-app notification document
        try {
          const notifRef = db.collection('users').doc(recipientId).collection('notifications').doc();
          await notifRef.set({
            notificationId: notifRef.id,
            userId: recipientId,
            title: notifTitle,
            body: notifBody,
            type: 'chat_message',
            rideId: cleanRideId,
            messageId: cleanMessageId,
            senderId: cleanSenderId,
            isRead: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (notifErr) {
          console.error(`[InApp] Error creating notification for recipient [${recipientId}]:`, notifErr.message);
        }

        // Query devices and send push notification
        try {
          const devices = await getUserDeviceTokens(recipientId);
          totalDeviceCount += devices.length;

          if (devices.length > 0) {
            const results = await Promise.all(
              devices.map(device =>
                sendPushNotification({
                  token: device.token,
                  title: notifTitle,
                  body: notifBody,
                  data: {
                    type: 'chat_message',
                    rideId: cleanRideId,
                    messageId: cleanMessageId,
                    senderId: cleanSenderId,
                  },
                  userId: recipientId,
                })
              )
            );
            const succ = results.filter(r => r.success).length;
            totalSentCount += succ;
          }
        } catch (fcmErr) {
          console.error(`[FCM] Error dispatching push for recipient [${recipientId}]:`, fcmErr.message);
        }
      })
    );

    // 10. Mark message as notificationsDispatched to ensure idempotency
    try {
      await messageDoc.ref.update({ notificationsDispatched: true });
    } catch (_) {}

    console.log(
      `[FCM] Chat message notification delivered to ${totalSentCount}/${totalDeviceCount} devices across ${recipients.length} recipients for ride [${cleanRideId}]`
    );

    return res.status(200).json({
      success: true,
      sentCount: totalSentCount,
      totalDevices: totalDeviceCount,
      recipientsCount: recipients.length,
    });
  } catch (error) {
    console.error('[API] Error in /notify-chat-message:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error while processing chat message notification',
    });
  }
});

module.exports = router;


