const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const EXPECTED_PROJECT_ID = 'campusride-7a9be';

let isInitialized = false;

/**
 * Safely initialize Firebase Admin SDK using externalized credentials
 */
function initFirebaseAdmin() {
  if (isInitialized && admin.apps.length > 0) {
    return admin.app();
  }

  let serviceAccount = null;

  // 1. Try FIREBASE_SERVICE_ACCOUNT environment variable (raw JSON or base64)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      const jsonStr = raw.startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf8');
      serviceAccount = JSON.parse(jsonStr);
      console.log('[Firebase] Loaded credentials from FIREBASE_SERVICE_ACCOUNT env variable.');
    } catch (parseErr) {
      console.error('[Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT env variable:', parseErr.message);
    }
  }

  // 2. If not loaded from env, check candidate file paths
  if (!serviceAccount) {
    const candidatePaths = [
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      '/etc/secrets/service-account.json', // Render secret file path
      './secrets/service-account.json',
      path.resolve(process.cwd(), 'secrets/service-account.json'),
    ].filter(Boolean);

    let foundPath = null;
    for (const p of candidatePaths) {
      const resolved = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
      if (fs.existsSync(resolved)) {
        foundPath = resolved;
        break;
      }
    }

    if (!foundPath) {
      console.warn('\n=============================================================');
      console.warn('[Firebase] WARNING: Service account credentials not found.');
      console.warn('[Firebase] Provide FIREBASE_SERVICE_ACCOUNT env var or place file at secrets/service-account.json');
      console.warn('=============================================================\n');
      return null;
    }

    try {
      serviceAccount = JSON.parse(fs.readFileSync(foundPath, 'utf8'));
      console.log(`[Firebase] Loaded credentials from file: ${foundPath}`);
    } catch (fileErr) {
      console.error('[Firebase] Failed to read credentials file:', fileErr.message);
      throw fileErr;
    }
  }

  try {
    // Validate project ID matches target Firebase project
    if (serviceAccount.project_id && serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
      throw new Error(
        `Firebase project ID mismatch. Expected "${EXPECTED_PROJECT_ID}", but service account is for "${serviceAccount.project_id}".`
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: EXPECTED_PROJECT_ID,
    });

    isInitialized = true;
    console.log(`[Firebase] Project: ${EXPECTED_PROJECT_ID}`);
    console.log('[Firebase] Admin SDK initialized successfully');
    return admin.app();
  } catch (error) {
    console.error('[Firebase] Failed to initialize Firebase Admin SDK:', error.message);
    throw error;
  }
}

// Initialize on module load
try {
  initFirebaseAdmin();
} catch (_) {
  // Gracefully deferred until credentials are provided
}

/**
 * Mask an FCM token for safe logging
 * @param {string} token 
 * @returns {string}
 */
function maskToken(token) {
  if (!token || typeof token !== 'string') return 'invalid_token';
  if (token.length <= 12) return '***';
  return `${token.substring(0, 8)}...${token.substring(token.length - 4)}`;
}

/**
 * Retrieve registered device tokens for a given user from Firestore:
 * users/{uid}/devices/{deviceId}
 * 
 * @param {string} uid 
 * @returns {Promise<Array<{docId: string, token: string, platform: string}>>}
 */
async function getUserDeviceTokens(uid) {
  if (!admin.apps.length) {
    throw new Error('Firebase Admin SDK is not initialized. Check credentials file.');
  }

  if (!uid || typeof uid !== 'string') {
    throw new Error('Invalid user ID provided for token lookup');
  }

  try {
    const db = admin.firestore();
    const snapshot = await db
      .collection('users')
      .doc(uid)
      .collection('devices')
      .get();

    if (snapshot.empty) {
      return [];
    }

    const devices = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data && typeof data.token === 'string' && data.token.trim().length > 0) {
        devices.push({
          docId: doc.id,
          token: data.token.trim(),
          platform: data.platform || 'unknown',
          updatedAt: data.updatedAt || null,
        });
      }
    });

    return devices;
  } catch (error) {
    console.error(`[FCM] Error fetching device tokens for UID: ${uid}:`, error.message);
    throw new Error('Failed to retrieve user device tokens');
  }
}

/**
 * Send a push notification using Firebase Admin Messaging
 * 
 * @param {Object} params
 * @param {string} params.token - FCM device token
 * @param {string} params.title - Notification title
 * @param {string} params.body - Notification body
 * @param {Object} [params.data] - Custom data payload
 * @param {string} [params.userId] - Optional userId to auto-prune stale token
 * @returns {Promise<{success: boolean, messageId?: string, error?: string, isStale?: boolean}>}
 */
async function sendPushNotification({ token, title, body, data = {}, userId = null }) {
  if (!admin.apps.length) {
    throw new Error('Firebase Admin SDK is not initialized. Check credentials file.');
  }

  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return { success: false, error: 'Valid FCM registration token is required' };
  }

  const cleanToken = token.trim();
  const masked = maskToken(cleanToken);

  // Stringify all data values for FCM specification
  const stringifiedData = {};
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && val !== null) {
      stringifiedData[key] = String(val);
    }
  }

  const message = {
    token: cleanToken,
    notification: {
      title: title || 'CampusRide',
      body: body || '',
    },
    data: {
      ...stringifiedData,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'campusride_alerts',
        sound: 'default',
        priority: 'high',
        defaultSound: true,
        defaultVibrateTimings: true,
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    },
  };

  try {
    console.log(`[FCM] Sending push notification to token [${masked}]`);
    const response = await admin.messaging().send(message);
    console.log(`[FCM] Notification send successful, messageId: ${response}`);
    return { success: true, messageId: response };
  } catch (error) {
    const errorCode = error.code || '';
    console.error(`[FCM] Notification send failed for [${masked}]:`, errorCode || error.message);

    // Identify stale / unregistered token
    const isStale =
      errorCode === 'messaging/registration-token-not-registered' ||
      errorCode === 'messaging/invalid-registration-token';

    if (isStale && userId) {
      try {
        console.log(`[FCM] Pruning stale token for UID: ${userId}`);
        const db = admin.firestore();
        const deviceDocId = cleanToken.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
        await db
          .collection('users')
          .doc(userId)
          .collection('devices')
          .doc(deviceDocId)
          .delete();
        console.log(`[FCM] Stale token document pruned: ${deviceDocId}`);
      } catch (pruneErr) {
        console.warn(`[FCM] Failed to prune stale token document:`, pruneErr.message);
      }
    }

    return {
      success: false,
      error: errorCode || 'Failed to deliver notification',
      isStale,
    };
  }
}

module.exports = {
  admin,
  initFirebaseAdmin,
  getUserDeviceTokens,
  sendPushNotification,
  maskToken,
  EXPECTED_PROJECT_ID,
};

