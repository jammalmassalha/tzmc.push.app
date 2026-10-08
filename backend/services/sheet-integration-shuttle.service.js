/**
 * Google Sheets Integration Service
 * Handles posting shuttle orders to Google Sheets via webhook
 */

/**
 * Posts an order row to Google Apps Script / Google Sheets webhook
 * @param {Object} order - The shuttle order object from database
 * @param {string} webhookUrl - The Google Apps Script deployment URL
 * @returns {Promise<Object>} Response from Google Apps Script
 * @throws {Error} If the request fails
 */
async function postOrderToGoogleSheet(order, webhookUrl) {
  if (!webhookUrl) {
    throw new Error('GOOGLE_SHEET_WEBHOOK_URL environment variable is missing');
  }

  const payload = {
    action: 'addShuttleOrder',
    orderId: order.id,
    userName: order.user_name,
    phone: order.phone,
    pickup: order.pickup_location,
    dropoff: order.dropoff_location,
    pickupTime: order.pickup_time,
    passengers: order.passengers_count,
    notes: order.notes,
    createdAt: order.created_at
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Check for successful response
      if (response.status !== 200) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text || 'No response body'}`);
      }

      const data = await response.json();

      // Check if Google Apps Script returned an error
      if (data && data.status === 'error') {
        throw new Error(data.message || 'Google Sheets API returned an error');
      }

      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    // Re-throw with additional context
    if (error.name === 'AbortError') {
      throw new Error('Google Sheets request timeout (15s)');
    } else if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON response from Google Sheets: ${error.message}`);
    } else {
      throw error;
    }
  }
}

module.exports = {
  postOrderToGoogleSheet
};
