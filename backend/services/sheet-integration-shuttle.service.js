/**
 * Google Sheets Integration Service
 * Handles posting shuttle orders to Google Sheets via webhook
 */

const axios = require('axios');

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
    const response = await axios.post(webhookUrl, payload, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });

    // Check for successful response
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} failed`);
    }

    // Check if Google Apps Script returned an error
    if (response.data && response.data.status === 'error') {
      throw new Error(response.data.message || 'Google Sheets API returned an error');
    }

    return response.data;
  } catch (error) {
    // Re-throw with additional context
    if (error.response) {
      // Request made and server responded with error status
      throw new Error(`Google Sheets API error: ${error.response.status} - ${error.response.data?.message || error.message}`);
    } else if (error.code === 'ECONNABORTED') {
      throw new Error('Google Sheets request timeout (15s)');
    } else {
      throw error;
    }
  }
}

module.exports = {
  postOrderToGoogleSheet
};
