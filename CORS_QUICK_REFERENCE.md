# CORS Quick Reference Guide

Quick answers for common deployment scenarios.

## 🟢 Scenario 1: Same-Origin Deployment (Recommended)

**Setup:** Flutter web app deployed from the same origin as the backend
- Example: `https://www.tzmc.co.il/flutterapp/` → backend at `https://www.tzmc.co.il/notify`

### What You Need
- ✅ CORS is **NOT** required (same-origin requests work automatically)
- ✅ Cookies are sent automatically
- ✅ No preflight requests needed

### Backend Configuration
```bash
# No special configuration needed!
# Default ALLOWED_HOSTS already includes www.tzmc.co.il
```

### Flutter Configuration
```dart
// flutter_app/lib/core/config/environment.dart
static const EnvironmentConfig production = EnvironmentConfig(
  baseUrl: 'https://www.tzmc.co.il/notify',  // Same origin as deployed app
  ...
);
```

### Deployment Steps
1. Build Flutter web app with base-href `/flutterapp/`:
   ```bash
   flutter build web --base-href /flutterapp/
   ```

2. Deploy `build/web` to `server.js` dist/web or similar directory

3. Configure server to serve it from `/flutterapp/` route

4. Verify by visiting `https://www.tzmc.co.il/flutterapp/`

### ✅ You're Done!
If the app loads and you can log in, CORS is working correctly.

---

## 🟡 Scenario 2: Subdomain Deployment

**Setup:** Flutter web app deployed to a subdomain of the same parent domain
- Example: `https://app.tzmc.co.il/` → backend at `https://www.tzmc.co.il/notify`

### What You Need
- ✅ CORS is required (different subdomains = different origins)
- ⚠️ Must configure ALLOWED_HOSTS for the subdomain
- ⚠️ Cookies may not be shared between subdomains (depends on cookie domain)

### Backend Configuration
```bash
# Set environment variable
export ALLOWED_HOSTS=tzmc.co.il,www.tzmc.co.il,*.tzmc.co.il,app.tzmc.co.il

# Or use wildcard
export ALLOWED_HOSTS=*.tzmc.co.il
```

### Flutter Configuration
```dart
// flutter_app/lib/core/config/environment.dart
static const EnvironmentConfig production = EnvironmentConfig(
  baseUrl: 'https://www.tzmc.co.il/notify',  // Backend origin
  ...
);
```

### Backend Cookie Domain Configuration
Ensure Set-Cookie header includes domain:
```javascript
// In backend session creation
res.cookie('session', token, {
  domain: '.tzmc.co.il',  // Allows all subdomains to access the cookie
  secure: true,
  httpOnly: true,
  sameSite: 'None'
});
```

### ✅ Verification
```bash
# Check that origin is allowed
curl -H "Origin: https://app.tzmc.co.il" -X OPTIONS \
  https://www.tzmc.co.il/notify/auth/session/status -v

# Should show:
# < Access-Control-Allow-Origin: https://app.tzmc.co.il
# < Access-Control-Allow-Credentials: true
```

---

## 🔴 Scenario 3: Cross-Domain Deployment (Not Recommended)

**Setup:** Flutter web app deployed to completely different domain
- Example: `https://app.example.com/` → backend at `https://www.tzmc.co.il/notify`

### What You Need
- ⚠️ Full CORS configuration required
- ⚠️ Origin must be explicitly added to ALLOWED_HOSTS
- ⚠️ Cookies cannot be shared across different domains (browser security)
- ⚠️ Backend must explicitly allow this origin

### Backend Configuration
```bash
# Must add the new domain to ALLOWED_HOSTS
export ALLOWED_HOSTS=tzmc.co.il,www.tzmc.co.il,*.tzmc.co.il,app.example.com
```

### Flutter Configuration
```dart
// flutter_app/lib/core/config/environment.dart
static const EnvironmentConfig production = EnvironmentConfig(
  baseUrl: 'https://www.tzmc.co.il/notify',  // Still backend origin
  ...
);
```

### Important Limitations
- ❌ **Cookies cannot be shared** between different domains
- ❌ Session cookies set on `www.tzmc.co.il` won't be sent from `app.example.com`
- ❌ You'll need to implement alternative authentication (e.g., OAuth, API tokens)

### Workarounds (if required)
1. **Use API Token Authentication**
   ```dart
   // Instead of relying on cookies, use a token
   _client.post<Map>(
     '/auth/session/status',
     options: Options(headers: {
       'Authorization': '******'
     })
   );
   ```

2. **Use Proxy Pattern**
   - Have your domain proxy requests to the backend
   - Browser sees same origin, cookies work normally
   - Example: `https://app.example.com/api/*` → proxies to `https://www.tzmc.co.il/notify/*`

3. **Use Backend as a Proxy**
   - Deploy backend API on your domain
   - Backend proxies requests to the main service

### ✅ Verification
```bash
# Verify origin is allowed
curl -H "Origin: https://app.example.com" -X OPTIONS \
  https://www.tzmc.co.il/notify/auth/session/status -v

# Should show:
# < Access-Control-Allow-Origin: https://app.example.com
# < Access-Control-Allow-Credentials: true
```

---

## 🔵 Scenario 4: Development/Local Testing

**Setup:** Testing locally with different ports
- Example: `http://localhost:3000/` → backend at `http://localhost:8080/notify`

### What You Need
- ✅ Different ports = different origins → CORS required
- ✅ Localhost/127.0.0.1 already in default ALLOWED_HOSTS
- ✅ Works for development with minimal setup

### Backend Configuration
```bash
# Default ALLOWED_HOSTS includes localhost
# No additional configuration needed!

# If using a custom IP:
export ALLOWED_HOSTS=localhost,127.0.0.1,192.168.1.100
```

### Flutter Configuration (for local testing)
```dart
// Create a development environment config
static const EnvironmentConfig development = EnvironmentConfig(
  environment: Environment.development,
  baseUrl: 'http://localhost:8080/notify',  // Local backend
  enableLogging: true,
  enableAnalytics: false,
);
```

### Run Locally
```bash
# Terminal 1: Backend
npm start  # Runs on port 8080

# Terminal 2: Flutter web dev server
cd flutter_app
flutter run -d chrome  # Or your browser

# Should automatically use http://localhost:XXXX/
# and connect to http://localhost:8080/notify
```

### ✅ Verification
```bash
# Check browser console - should not see CORS errors
# Network tab should show successful requests
# Cookies should be included in requests
```

---

## 📋 Troubleshooting by Scenario

### Same-Origin (Scenario 1)
| Problem | Solution |
|---------|----------|
| CORS error | Move CORS middleware before static middleware (already done) |
| Cookies not sent | Ensure `withCredentials = true` in Dio setup |
| 404 on assets | Verify base-href matches deployment path |

### Subdomain (Scenario 2)
| Problem | Solution |
|---------|----------|
| CORS error | Add subdomain to ALLOWED_HOSTS |
| Cookies not shared | Set cookie domain to `.tzmc.co.il` (with leading dot) |
| Preflight failing | Ensure OPTIONS requests don't require auth |

### Cross-Domain (Scenario 3)
| Problem | Solution |
|---------|----------|
| CORS error | Add domain to ALLOWED_HOSTS |
| Cookies not working | Use API tokens instead of cookies |
| Session lost | Cookies cannot cross domains - use alternative auth |

### Development (Scenario 4)
| Problem | Solution |
|---------|----------|
| CORS error | Ensure backend includes localhost in ALLOWED_HOSTS |
| Port mismatch | Update baseUrl to match backend port |
| Refresh loses auth | Check if dev server clears cookies on reload |

---

## 🔧 Quick Configuration Commands

```bash
# Check current CORS configuration
grep -A 30 "const corsOptions" server.js

# Check middleware order
grep -n "app.use(cors\|app.use(express.static" server.js
# CORS should come before static!

# Check ALLOWED_HOSTS
echo $ALLOWED_HOSTS

# Set ALLOWED_HOSTS for development
export ALLOWED_HOSTS="localhost,127.0.0.1,*.tzmc.co.il"

# Restart backend to apply
npm restart
```

---

## 📚 Related Documentation

- **CORS_DEPLOYMENT_GUIDE.md** - Detailed configuration reference
- **CORS_VERIFICATION_CHECKLIST.md** - Step-by-step verification
- **server.js** - Backend CORS implementation (lines 335-415)
- **flutter_app/lib/core/api/cookie_setup_web.dart** - Dio credentials setup

---

## ❓ Still Having Issues?

1. **Read CORS_VERIFICATION_CHECKLIST.md** - Run through each step
2. **Check browser DevTools Network tab** - Look for CORS headers
3. **Review CORS_DEPLOYMENT_GUIDE.md** - Detailed troubleshooting section
4. **Test with curl** - Isolate frontend from backend issues
5. **Enable debug logging** - Set `enableLogging: true` in environment.dart

**Most Common Fix:** Move CORS middleware before static middleware ✅ (Already done in this fix)
