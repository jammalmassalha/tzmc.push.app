import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tzmc_push/core/utils/device_id.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    resetDeviceIdCacheForTesting();
    SharedPreferences.setMockInitialValues({});
  });

  test('generates and persists an id on first use', () async {
    final id = await ensureDeviceId();

    expect(id, isNotEmpty);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString(kDeviceIdStorageKey), id);
  });

  test('returns the same id on subsequent calls', () async {
    final first = await ensureDeviceId();
    resetDeviceIdCacheForTesting();
    final second = await ensureDeviceId();

    expect(second, first);
  });

  test('reuses an already stored id instead of generating a new one', () async {
    SharedPreferences.setMockInitialValues({kDeviceIdStorageKey: 'dev-existing'});

    expect(await ensureDeviceId(), 'dev-existing');
  });

  test('cachedDeviceId is empty until the id has been resolved', () async {
    expect(cachedDeviceId, isEmpty);

    final id = await ensureDeviceId();

    expect(cachedDeviceId, id);
  });

  test('two installs do not collide', () async {
    final first = await ensureDeviceId();
    resetDeviceIdCacheForTesting();
    SharedPreferences.setMockInitialValues({});
    final second = await ensureDeviceId();

    expect(second, isNot(first));
  });
}
