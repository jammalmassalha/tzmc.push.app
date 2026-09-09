import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:tzmc_push/core/services/otp_throttle_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late DateTime clock;
  late OtpThrottleService service;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    clock = DateTime.utc(2026, 1, 1, 10);
    service = OtpThrottleService(now: () => clock);
  });

  test('allows the first send', () async {
    final decision = await service.check('0501234567');
    expect(decision.allowed, isTrue);
    expect(decision.remainingSends, kOtpMaxSendsPerWindow);
  });

  test('blocks a second send within 120 seconds', () async {
    await service.recordSend('0501234567');

    clock = clock.add(const Duration(seconds: 30));
    final decision = await service.check('0501234567');

    expect(decision.allowed, isFalse);
    expect(decision.quotaExhausted, isFalse);
    expect(decision.retryAfter.inSeconds, 90);
  });

  test('allows a send once the 120 second gap elapsed', () async {
    await service.recordSend('0501234567');

    clock = clock.add(kOtpMinInterval);
    final decision = await service.check('0501234567');

    expect(decision.allowed, isTrue);
    expect(decision.remainingSends, kOtpMaxSendsPerWindow - 1);
  });

  test('blocks the fifth send inside the rolling hour', () async {
    for (var i = 0; i < kOtpMaxSendsPerWindow; i++) {
      await service.recordSend('0501234567');
      clock = clock.add(kOtpMinInterval);
    }

    final decision = await service.check('0501234567');
    expect(decision.allowed, isFalse);
    expect(decision.quotaExhausted, isTrue);
    expect(decision.remainingSends, 0);
    // The oldest send was 4 * 120s ago, so the hour frees up 480s from now.
    expect(decision.retryAfter.inSeconds, kOtpWindow.inSeconds - 480);
  });

  test('allows sending again once the oldest send ages out of the window', () async {
    for (var i = 0; i < kOtpMaxSendsPerWindow; i++) {
      await service.recordSend('0501234567');
      clock = clock.add(kOtpMinInterval);
    }

    clock = clock.add(kOtpWindow);
    final decision = await service.check('0501234567');

    expect(decision.allowed, isTrue);
    expect(decision.remainingSends, kOtpMaxSendsPerWindow);
  });

  test('tracks numbers independently and normalizes formatting', () async {
    await service.recordSend('050-123-4567');

    final sameNumber = await service.check('050 1234567');
    expect(sameNumber.allowed, isFalse);

    final otherNumber = await service.check('0529998888');
    expect(otherNumber.allowed, isTrue);
  });

  test('clear() removes the history for a number', () async {
    await service.recordSend('0501234567');
    expect((await service.check('0501234567')).allowed, isFalse);

    await service.clear('0501234567');
    expect((await service.check('0501234567')).allowed, isTrue);
  });

  test('degrades to allowed for an empty phone number', () async {
    await service.recordSend('');
    final decision = await service.check('   ');
    expect(decision.allowed, isTrue);
  });

  test('ignores corrupted stored history', () async {
    SharedPreferences.setMockInitialValues({
      kOtpSendHistoryStorageKey: 'not-json',
    });

    final decision = await service.check('0501234567');
    expect(decision.allowed, isTrue);
  });

  test('blocked decisions expose a Hebrew message', () async {
    await service.recordSend('0501234567');
    final decision = await service.check('0501234567');

    expect(decision.allowed, isFalse);
    expect(decision.message, contains('קוד אימות'));
  });
}
