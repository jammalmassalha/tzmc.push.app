# CORS Configuration and Deployment Guide

## Issue: Canceled Session Status Requests

When the Flutter web app makes credentialed requests (like `/notify/auth/session/status`), browsers require proper CORS headers to be set on all responses. If CORS headers are missing or incomplete, the browser will cancel the request as a security measure.

## Root Causes

1. **Middleware Ordering**: CORS middleware was applied after static middleware, so CORS headers weren't being set on responses from static files or early middleware.
2. **Missing Credentials Header**: The `Access-Control-Allow-Credentials: true` header must be explicitly set for credentialed cross-origin requests.
3. **Cross-Origin Deployment**: If the Flutter web app is deployed to a different origin than the backend, proper CORS configuration is required.

## Solution Implemented

### 1. Middleware Ordering (Fixed in server.js)
- ✅ CORS middleware now runs BEFORE static middleware
- ✅ OPTIONS preflight requests are handled before any routes
- ✅ All responses include proper CORS headers

### 2. Explicit Credentials Header (Fixed in server.js)
- ✅ Added middleware to explicitly set `Access-Control-Allow-Credentials: true`
- ✅ Header is only set when the origin is in the allowed hosts list
- ✅ Applies to all HTTP methods (GET, POST, PUT, PATCH, DELETE, OPTIONS)

### 3. Exposed Headers Configuration
- ✅ Added `exposedHeaders` to CORS options
- ✅ Includes headers that the client-side JavaScript can read:
  - `X-CSRF-Token` (security token)
  - `Retry-After` (rate limiting)
  - `X-RateLimit-*` (rate limit info)

## Deployment Configuration

### Same-Origin Deployment (Recommended)
If deploying the Flutter web app from the same origin as the backend (e.g., both at `https://www.tzmc.co.il`):
- ✅ No additional configuration needed
- ✅ CORS is not required (same-origin requests work automatically)
- ✅ Browser cookies are sent/received automatically
- ✅ No preflight requests needed

**Deployment path example**: `https://www.tzmc.co.il/flutterapp/`

### Cross-Origin Deployment
If deploying the Flutter web app to a different origin (e.g., `https://app.example.com`):

1. **Ensure the origin is in ALLOWED_HOSTS**
   ```bash
   # On the backend server, set the environment variable:
   export ALLOWED_HOSTS=tzmc.co.il,www.tzmc.co.il,*.tzmc.co.il,app.example.com
   ```

2. **Verify the Flutter app baseUrl matches the backend**
   - In `flutter_app/lib/core/config/environment.dart`:
   ```dart
   static const EnvironmentConfig production = EnvironmentConfig(
     environment: Environment.production,
     baseUrl: 'https://www.tzmc.co.il/notify',  // Must be the backend origin
     enableLogging: false,
     enableAnalytics: true,
   );
   ```

3. **Verify the Flutter web app enables credentials**
   - In `flutter_app/lib/core/api/cookie_setup_web.dart`:
   ```dart
   final adapter = BrowserHttpClientAdapter()..withCredentials = true;
   ```
   This is already configured correctly.

## Testing CORS Configuration

### Using curl (without credentials, should still have CORS headers)
```bash
curl -H "Origin: https://www.tzmc.co.il" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: Content-Type" \
     -X OPTIONS https://www.tzmc.co.il/notify/auth/session/status
```

Expected response headers:
```
Access-Control-Allow-Origin: https://www.tzmc.co.il
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, Cache-Control, Pragma, Last-Event-ID, X-Requested-With, X-CSRF-Token
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 86400
```

### Using browser DevTools
1. Open DevTools → Network tab
2. Make a request to `/notify/auth/session/status`
3. Look for response headers:
   - ✅ `Access-Control-Allow-Credentials: true`
   - ✅ `Access-Control-Allow-Origin: https://www.tzmc.co.il` (or your origin)
   - ✅ `Access-Control-Allow-Methods` includes POST
   - ✅ `Access-Control-Allow-Headers` includes X-CSRF-Token

### Testing with JavaScript
```javascript
// This will only work if CORS is properly configured
fetch('https://www.tzmc.co.il/notify/auth/session/status', {
  method: 'POST',
  credentials: 'include',  // Send cookies with cross-origin request
  headers: {
    'Content-Type': 'application/json'
  }
}).then(response => console.log(response))
  .catch(error => console.error('CORS Error:', error));
```

If you see an error like "Access to XMLHttpRequest at 'https://...' from origin '...' has been blocked by CORS policy", then CORS headers are not being set properly.

## Troubleshooting

### Problem: Requests are still being canceled
**Solution**: 
1. Check if the origin is in ALLOWED_HOSTS
2. Verify CORS middleware runs before your routes
3. Check response headers using browser DevTools
4. Ensure `credentials: true` is set in fetch options (on the client)

### Problem: Cookies not being sent with cross-origin requests
**Solution**:
1. Verify `Access-Control-Allow-Credentials: true` header is present
2. Ensure client uses `credentials: 'include'` in fetch options
3. Verify cookie domain is set correctly by the backend

### Problem: OPTIONS preflight requests returning 404
**Solution**:
1. Ensure `app.options(/.*/, cors(corsOptions))` is registered
2. CORS middleware must run before route handlers
3. OPTIONS requests should not require authentication

## Configuration Environment Variables

```bash
# Allowed hosts for CORS and Host header validation
# (Default includes tzmc.co.il, www.tzmc.co.il, *.tzmc.co.il, localhost, 127.0.0.1, ::1)
ALLOWED_HOSTS=tzmc.co.il,www.tzmc.co.il,*.tzmc.co.il,localhost,app.example.com

# Allow any host (not recommended for production)
ALLOWED_HOSTS=*
```

## Related Files

- `server.js`: CORS middleware configuration (lines ~335-415)
- `flutter_app/lib/core/api/http_client.dart`: Dio HTTP client setup
- `flutter_app/lib/core/api/cookie_setup_web.dart`: Browser credentials setup
- `flutter_app/lib/core/config/environment.dart`: Environment baseUrl configuration
- `backend/middleware/authorized-user.middleware.js`: Session extraction

## Security Notes

- CORS is only allowed for origins in the ALLOWED_HOSTS list
- The `Referrer-Policy: no-referrer` header prevents leaking sensitive URLs
- Credentials are only sent to allowed origins
- Preflight requests (OPTIONS) are handled before route handlers to prevent information leakage

## References

- [MDN: CORS with Credentials](https://developer.mozilla.org/en-US/docs/Web/API/fetch#credentials)
- [MDN: Access-Control-Allow-Credentials](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Credentials)
- [OWASP: CORS Security](https://owasp.org/www-community/attacks/CSRF#cors_protection)
