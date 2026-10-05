# CORS Configuration Verification Checklist

Use this checklist to verify that the CORS fix for canceled requests is working correctly.

## Pre-Deployment Verification

### 1. Backend Configuration
- [ ] Verify CORS middleware is applied EARLY in server.js (before static middleware)
  ```bash
  grep -n "app.use(cors(corsOptions))\|app.use(express.static" server.js
  # Should show CORS on a lower line number than static middleware
  ```

- [ ] Verify ALLOWED_HOSTS includes the deployment origin
  ```bash
  # Check environment variable
  echo $ALLOWED_HOSTS
  # Should include your domain or *.domain.com
  ```

- [ ] Verify credentialsheader middleware is present
  ```bash
  grep -A 5 "Access-Control-Allow-Credentials" server.js
  # Should show middleware that explicitly sets this header
  ```

### 2. Flutter Web App Configuration
- [ ] Verify baseUrl is set to the backend origin
  ```bash
  grep -A 2 "baseUrl:" flutter_app/lib/core/config/environment.dart
  # Should show https://www.tzmc.co.il/notify
  ```

- [ ] Verify withCredentials is enabled
  ```bash
  grep "withCredentials" flutter_app/lib/core/api/cookie_setup_web.dart
  # Should show withCredentials = true
  ```

## Runtime Verification

### 1. Browser DevTools Network Tab
Run these steps after deploying the app:

1. **Open the Flutter web app in a browser**
   - Navigate to your deployment URL
   - Open Developer Tools (F12)
   - Go to the Network tab

2. **Trigger a session status check**
   - The app should automatically check `/notify/auth/session/status` on load
   - Or navigate to a page that requires authentication
   - Look for a POST request to `/auth/session/status` in the Network tab

3. **Inspect the request**
   - Check the "Headers" tab for the request
   - Should show `credentials: include` in the request headers
   - Should show `Cookie: session=...` being sent

4. **Inspect the response**
   - Check the "Headers" tab for the response
   - Should see these response headers:
     ```
     Access-Control-Allow-Origin: https://your-origin.com (or the exact origin)
     Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
     Access-Control-Allow-Headers: Content-Type, Authorization, Cache-Control, Pragma, Last-Event-ID, X-Requested-With, X-CSRF-Token
     Access-Control-Allow-Credentials: true
     Access-Control-Expose-Headers: Content-Length, X-CSRF-Token, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
     ```

5. **Check response status**
   - Should NOT be 0 (canceled)
   - Should be 200 (OK) or 401 (Unauthorized), but NOT canceled

### 2. Browser Console Checks

In the browser console, run:
```javascript
// Check if fetch with credentials is working
fetch('/notify/auth/session/status', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json'
  }
})
.then(response => {
  console.log('✅ Request succeeded!');
  console.log('Status:', response.status);
  console.log('OK:', response.ok);
  return response.json();
})
.then(data => console.log('Response:', data))
.catch(error => {
  console.error('❌ Request failed!');
  console.error('Error:', error.message);
});
```

Expected output:
```
✅ Request succeeded!
Status: 200
OK: true
Response: { authenticated: true, user: "...", ... }
```

### 3. Manual cURL Testing (from the server)

```bash
# Test OPTIONS preflight
curl -v \
  -H "Origin: https://www.tzmc.co.il" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -X OPTIONS https://www.tzmc.co.il/notify/auth/session/status

# Should return 204 No Content with these headers:
# Access-Control-Allow-Credentials: true
# Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
# Access-Control-Allow-Headers: Content-Type, Authorization, ...
```

## Troubleshooting

### Issue: Request status is 0 (canceled)

**Possible causes:**
1. Missing `Access-Control-Allow-Credentials: true` header
2. CORS middleware runs after static middleware
3. Backend origin not in ALLOWED_HOSTS
4. Wrong baseUrl in Flutter environment config

**Solutions:**
```bash
# 1. Check middleware order in server.js
grep -n "app.use(cors\|app.use(express.static" server.js

# 2. Check ALLOWED_HOSTS
env | grep ALLOWED_HOSTS

# 3. Check if backend has the fix applied
grep -A 10 "Access-Control-Allow-Credentials" server.js

# 4. Verify Flutter baseUrl
grep baseUrl flutter_app/lib/core/config/environment.dart
```

### Issue: Cookies not being sent with requests

**Causes:**
1. Client not setting `credentials: 'include'` (should be automatic in Dio)
2. Cookie domain mismatch
3. Missing `SameSite=None; Secure` in Set-Cookie header

**Check:**
```javascript
// In browser console, check if cookie exists
document.cookie
// Should show session cookie if logged in
```

### Issue: CORS error in browser console

**Error message:**
```
Access to XMLHttpRequest at 'https://...' from origin 'https://...' 
has been blocked by CORS policy: Response to preflight request doesn't pass access control check: 
The value of the 'Access-Control-Allow-Credentials' header in the response is '' which must be 'true'
```

**Solution:**
1. Verify backend is returning `Access-Control-Allow-Credentials: true`
2. Ensure CORS middleware runs before routes
3. Check that the origin is in ALLOWED_HOSTS

### Issue: 404 on OPTIONS requests

**Cause:** CORS middleware not registered for OPTIONS requests

**Check:**
```bash
grep "app.options" server.js
# Should show: app.options(/.*/, cors(corsOptions));
```

## Performance Verification

After CORS fix is deployed:

### 1. Session Status Request Performance
- [ ] Request to `/notify/auth/session/status` completes in < 200ms
- [ ] No network retries needed
- [ ] Response includes all expected data (user, csrf token, etc.)

### 2. Preflight Requests
- [ ] Preflight (OPTIONS) requests are not visible in most cases (cached by browser)
- [ ] Or if visible, complete in < 100ms
- [ ] Return 204 No Content or 200 OK

### 3. Overall App Performance
- [ ] App loads without network timeouts
- [ ] Session check happens on app startup
- [ ] User authentication flow works smoothly
- [ ] No console errors related to CORS

## Sign-Off

- [ ] Backend CORS configuration verified
- [ ] Flutter web app configuration verified
- [ ] Browser network tab shows proper CORS headers
- [ ] No canceled requests in network tab
- [ ] Console shows no CORS errors
- [ ] Session status check succeeds
- [ ] Authentication flow completes successfully
- [ ] All API requests succeed with proper CORS headers

## Documentation

Related files:
- `CORS_DEPLOYMENT_GUIDE.md` - Full deployment instructions
- `server.js` - Backend CORS configuration
- `flutter_app/lib/core/api/http_client.dart` - Dio HTTP client setup
- `flutter_app/lib/core/api/cookie_setup_web.dart` - Browser credentials setup
- `flutter_app/lib/core/config/environment.dart` - Environment configuration

## Next Steps

If you're still experiencing issues after following this checklist:

1. **Enable debug logging** in the Flutter app:
   ```bash
   # Set enableLogging: true in environment.dart
   # Then rebuild: flutter build web
   ```

2. **Check backend logs** for CORS-related errors or missing headers

3. **Review browser console** for any CORS policy violations

4. **Test with curl** to isolate backend issues from frontend issues

5. **Consult CORS_DEPLOYMENT_GUIDE.md** for additional troubleshooting steps
