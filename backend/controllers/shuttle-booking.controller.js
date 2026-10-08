/**
 * Shuttle Booking Controller
 * Handles creation of shuttle bookings with Transactional Outbox pattern
 * 
 * Orders are saved to MySQL immediately with PENDING status,
 * and the client receives a 200 OK response without waiting for Google Sheets sync.
 */

const { saveShuttleOrder } = require('../services/shuttle-orders.service');

/**
 * Create a new shuttle booking
 * Saves the order to MySQL immediately and returns success to the client
 * Google Sheets sync happens asynchronously in the background
 * 
 * POST /shuttle/booking
 * POST /notify/shuttle/booking
 */
function createShuttleBooking(dbPool) {
  return async (req, res) => {
    if (!dbPool) {
      return res.status(503).json({
        success: false,
        error: 'Database service is not available'
      });
    }

    try {
      const {
        userId,
        userName,
        phone,
        pickupLocation,
        dropoffLocation,
        pickupTime,
        passengersCount,
        notes
      } = req.body;

      // Validate required fields
      if (!pickupLocation || !dropoffLocation || !pickupTime) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: pickupLocation, dropoffLocation, pickupTime'
        });
      }

      // Save directly to MySQL with PENDING status
      const orderId = await saveShuttleOrder(dbPool, {
        userId,
        userName,
        phone,
        pickupLocation,
        dropoffLocation,
        pickupTime,
        passengersCount,
        notes,
        rawPayload: req.body
      });

      // Return success immediately - user doesn't wait for Google Sheets sync
      return res.status(200).json({
        success: true,
        orderId,
        message: 'Booking request received and is being processed.',
        syncStatus: 'PENDING'
      });
    } catch (error) {
      console.error('[ShuttleBooking] Error saving shuttle order to database:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to save booking'
      });
    }
  };
}

/**
 * Get shuttle booking status
 * Returns the current sync status of a booking
 * 
 * GET /shuttle/booking/:orderId
 * GET /notify/shuttle/booking/:orderId
 */
function getShuttleBookingStatus(dbPool) {
  return async (req, res) => {
    if (!dbPool) {
      return res.status(503).json({
        success: false,
        error: 'Database service is not available'
      });
    }

    try {
      const { orderId } = req.params;

      if (!orderId) {
        return res.status(400).json({
          success: false,
          error: 'Missing orderId parameter'
        });
      }

      const { getShuttleOrderById } = require('../services/shuttle-orders.service');
      const order = await getShuttleOrderById(dbPool, orderId);

      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Booking not found'
        });
      }

      return res.status(200).json({
        success: true,
        orderId: order.id,
        syncStatus: order.sync_status,
        retryCount: order.retry_count,
        syncedAt: order.synced_at,
        lastError: order.last_error,
        createdAt: order.created_at
      });
    } catch (error) {
      console.error('[ShuttleBooking] Error fetching booking status:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch booking status'
      });
    }
  };
}

/**
 * Register shuttle booking routes
 * Adds POST and GET endpoints to the Express app
 */
function registerShuttleBookingRoutes(app, dbPool) {
  const createBookingHandler = createShuttleBooking(dbPool);
  const getStatusHandler = getShuttleBookingStatus(dbPool);

  // Create booking endpoint
  app.post(
    ['/shuttle/booking', '/notify/shuttle/booking'],
    createBookingHandler
  );

  // Get booking status endpoint
  app.get(
    ['/shuttle/booking/:orderId', '/notify/shuttle/booking/:orderId'],
    getStatusHandler
  );

  console.log('[ShuttleBooking] Routes registered: POST /shuttle/booking, GET /shuttle/booking/:orderId');
}

module.exports = {
  createShuttleBooking,
  getShuttleBookingStatus,
  registerShuttleBookingRoutes
};
