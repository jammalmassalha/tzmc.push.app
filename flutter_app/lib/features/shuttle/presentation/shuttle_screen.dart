/// Shuttle screen - shuttle booking and status.
///
/// Allows users to book shuttle rides and view their bookings.
library;

import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/models/api_payloads.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/utils/toast_utils.dart';
import '../../../shared/theme/app_theme.dart';
import '../../auth/presentation/auth_state.dart';

// ---------------------------------------------------------------------------
// Shuttle Language + Booking Flow Step
// ---------------------------------------------------------------------------

/// UI display language for the shuttle feature, mirroring Angular's
/// `ShuttleLanguage = 'he' | 'ru'`.
enum ShuttleLanguage { he, ru }

/// Hebrew day names (Sun-Sat), mirroring `SHUTTLE_DAY_NAMES_BY_LANGUAGE.he`.
const List<String> _kDayNamesHe = [
  'ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'
];

/// Russian day names (Sun-Sat), mirroring `SHUTTLE_DAY_NAMES_BY_LANGUAGE.ru`.
const List<String> _kDayNamesRu = [
  'Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'
];

/// Represents the current step in the shuttle booking wizard
enum ShuttleBookingStep {
  menu,      // Initial menu - "הזמנה חדשה" button
  date,      // Date selection
  shift,     // Shift selection (morning/evening)
  station,   // Station selection
}

/// Status value sent to the server for a newly-active shuttle order, mirroring
/// `SHUTTLE_STATUS_ACTIVE_VALUE` in `frontend/src/app/core/services/chat-store.service.ts`.
const String shuttleStatusActiveValue = 'פעיל активный';

/// Status value sent to the server when cancelling a shuttle order, mirroring
/// `SHUTTLE_STATUS_CANCEL_VALUE` in the Angular store.
const String shuttleStatusCancelValue = 'ביטול נסיעה отмена поезд';

/// Time slots available as shuttle "shifts", mirroring `SHUTTLE_SHIFT_OPTIONS`
/// in the Angular store. The submit value carries the leading apostrophe so
/// the Google Sheet stores the value as text.
const List<({String label, String submitValue})> shuttleShiftOptions = [
  (label: '05:00', submitValue: "'05:00"),
  (label: '06:00', submitValue: "'06:00"),
  (label: '12:00', submitValue: "'12:00"),
  (label: '14:00', submitValue: "'14:00"),
  (label: '22:00', submitValue: "'22:00"),
];

// ---------------------------------------------------------------------------
// Shuttle State
// ---------------------------------------------------------------------------

/// Shuttle booking state
class ShuttleState {
  final List<String> stations;
  final List<ShuttleUserOrderPayload> userOrders;
  final bool isLoading;
  final String? error;

  // UI language (he / ru)
  final ShuttleLanguage language;
  
  // Booking wizard state
  final ShuttleBookingStep currentStep;
  final DateTime? selectedDate;
  final String? selectedShift;
  final String? selectedStation;

  const ShuttleState({
    this.stations = const [],
    this.userOrders = const [],
    this.isLoading = false,
    this.error,
    this.language = ShuttleLanguage.he,
    this.currentStep = ShuttleBookingStep.menu,
    this.selectedDate,
    this.selectedShift,
    this.selectedStation,
  });

  ShuttleState copyWith({
    List<String>? stations,
    List<ShuttleUserOrderPayload>? userOrders,
    bool? isLoading,
    String? error,
    ShuttleLanguage? language,
    ShuttleBookingStep? currentStep,
    DateTime? selectedDate,
    String? selectedShift,
    String? selectedStation,
    bool clearDate = false,
    bool clearShift = false,
    bool clearStation = false,
  }) {
    return ShuttleState(
      stations: stations ?? this.stations,
      userOrders: userOrders ?? this.userOrders,
      isLoading: isLoading ?? this.isLoading,
      error: error,
      language: language ?? this.language,
      currentStep: currentStep ?? this.currentStep,
      selectedDate: clearDate ? null : (selectedDate ?? this.selectedDate),
      selectedShift: clearShift ? null : (selectedShift ?? this.selectedShift),
      selectedStation: clearStation ? null : (selectedStation ?? this.selectedStation),
    );
  }
  
  /// Get ongoing orders
  List<ShuttleUserOrderPayload> get ongoingOrders => 
    userOrders.where((o) => o.isOngoing && !o.isCancelled).toList();
  
  /// Get past orders
  List<ShuttleUserOrderPayload> get pastOrders => 
    userOrders.where((o) => !o.isOngoing || o.isCancelled).toList();
    
  /// Check if we can go back from current step
  bool get canGoBack => currentStep != ShuttleBookingStep.menu;
}

// ---------------------------------------------------------------------------
// Shuttle Notifier
// ---------------------------------------------------------------------------

class ShuttleNotifier extends Notifier<ShuttleState> {
  late final ChatApiService _api;
  String? _currentUser;
  List<String>? _employeesCache;

  @override
  ShuttleState build() {
    _api = ref.watch(chatApiServiceProvider);
    _currentUser = ref.watch(currentUserProvider);
    return const ShuttleState();
  }

  Future<void> loadData() async {
    if (_currentUser == null) {
      state = state.copyWith(
        isLoading: false,
        error: 'יש להתחבר תחילה',
      );
      return;
    }

    // Stale-while-revalidate: if we already have data, refresh silently in the
    // background without showing a full-screen loading indicator.
    final hasData = state.stations.isNotEmpty || state.userOrders.isNotEmpty;
    if (!hasData) {
      state = state.copyWith(isLoading: true, error: null);
    }

    try {
      // Load stations and user orders in parallel
      final results = await Future.wait([
        _api.getShuttleStations(_currentUser!),
        _api.getShuttleUserOrders(_currentUser!),
      ]);
      
      state = state.copyWith(
        stations: results[0] as List<String>,
        userOrders: results[1] as List<ShuttleUserOrderPayload>,
        isLoading: false,
      );
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: 'שגיאה בטעינת נתונים: ${e.toString()}',
      );
    }
  }

  Future<void> loadUserOrders() async {
    if (_currentUser == null) return;
    
    try {
      final orders = await _api.getShuttleUserOrders(_currentUser!);
      state = state.copyWith(userOrders: orders);
    } catch (e) {
      // Silent failure for refresh
    }
  }

  Future<void> submitOrder({
    required String date,
    required String dateAlt,
    required String shift,
    required String station,
    required String status,
  }) async {
    if (_currentUser == null) {
      throw Exception('לא מחובר');
    }
    
    state = state.copyWith(isLoading: true, error: null);

    try {
      final employee = await _resolveEmployeeValue(_currentUser!);
      final payload = ShuttleOrderSubmitPayload(
        employee: employee,
        date: date,
        dateAlt: dateAlt,
        shift: shift,
        station: station,
        status: status,
      );
      
      await _api.submitShuttleOrder(payload, _currentUser!);
      state = state.copyWith(isLoading: false);
      // Reset wizard after successful submission
      resetWizard();
      // Background sync — don't block the success flow on the Google-Sheets round-trip.
      unawaited(loadUserOrders());
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: 'שגיאה בשליחת הזמנה: ${e.toString()}',
      );
      rethrow;
    }
  }

  /// Cancel an existing shuttle order by re-submitting it with the cancel
  /// status value, matching Angular's `cancelShuttleOrderById` flow.
  Future<void> cancelOrder(ShuttleUserOrderPayload order) async {
    if (_currentUser == null) {
      throw Exception('לא מחובר');
    }

    final dateIso = _resolveOrderDateIso(order);
    final shiftValue = _resolveOrderShiftSubmitValue(order);
    final station = (order.station ?? '').trim();
    if (dateIso.isEmpty || shiftValue.isEmpty || station.isEmpty) {
      throw Exception('פרטי הזמנה חסרים, לא ניתן לבטל');
    }

    state = state.copyWith(isLoading: true, error: null);
    try {
      final existingEmployee = (order.employee?.trim().isNotEmpty ?? false)
          ? order.employee!.trim()
          : '';
      final employee = existingEmployee.isNotEmpty
          ? existingEmployee
          : await _resolveEmployeeValue(_currentUser!);
      final payload = ShuttleOrderSubmitPayload(
        employee: employee,
        date: dateIso,
        dateAlt: DateFormat('yyyy-MM-dd').format(DateTime.now()),
        shift: shiftValue,
        station: station,
        status: shuttleStatusCancelValue,
      );
      await _api.submitShuttleOrder(payload, _currentUser!);
      // Optimistically mark the order as cancelled in local state so the UI
      // updates immediately without waiting for the next Google-Sheets round-trip.
      final optimistic = state.userOrders.map((o) {
        final sameRow = o.sheetRow != null && o.sheetRow == order.sheetRow;
        final sameId = o.id != null && o.id == order.id;
        if (sameRow || sameId || o == order) {
          return o.copyWith(
            isCancelled: true,
            isOngoing: false,
            status: shuttleStatusCancelValue,
          );
        }
        return o;
      }).toList();
      state = state.copyWith(userOrders: optimistic, isLoading: false);
      // Background sync to pull the authoritative server state.
      unawaited(loadUserOrders());
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: 'שגיאה בביטול הזמנה: ${e.toString()}',
      );
      rethrow;
    }
  }

  /// Resolve an order's date to an ISO `yyyy-MM-dd` string, accepting either
  /// `dateIso` (preferred) or a `dd/MM/yyyy` date string.
  String _resolveOrderDateIso(ShuttleUserOrderPayload order) {
    final iso = (order.dateIso ?? '').trim();
    if (iso.isNotEmpty) return iso;
    final raw = (order.date ?? '').trim();
    if (raw.isEmpty) return '';
    // Already ISO (yyyy-MM-dd)
    if (RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(raw)) return raw;
    // dd/MM/yyyy or dd.MM.yyyy
    final m = RegExp(r'^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$').firstMatch(raw);
    if (m != null) {
      final d = m.group(1)!.padLeft(2, '0');
      final mo = m.group(2)!.padLeft(2, '0');
      final y = m.group(3)!;
      return '$y-$mo-$d';
    }
    return raw;
  }

  /// Resolve the submit-value for an order's shift (e.g. `"'05:00"` with the
  /// leading apostrophe Angular uses to keep the Sheet column as text).
  String _resolveOrderShiftSubmitValue(ShuttleUserOrderPayload order) {
    final candidate = (order.shiftValue?.trim().isNotEmpty ?? false)
        ? order.shiftValue!.trim()
        : (order.shiftLabel ?? order.shift ?? '').trim();
    if (candidate.isEmpty) return '';
    if (candidate.startsWith("'")) return candidate;
    final hhmm = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(candidate);
    if (hhmm != null) {
      final h = hhmm.group(1)!.padLeft(2, '0');
      return "'$h:${hhmm.group(2)}";
    }
    return candidate;
  }

  // ---------------------------------------------------------------------------
  // Employee value resolution (mirrors Angular's `resolveShuttleEmployeeValue`).
  // The Google Sheet expects the "employee" column to contain the user's full
  // name together with the phone number, not just the bare phone number.
  // ---------------------------------------------------------------------------

  /// Resolve the value submitted in the `employee` column. Tries to match the
  /// authenticated user against the shuttle employees list (which already
  /// stores `Full Name 05XXXXXXXX`), and falls back to combining the contact's
  /// display name with the user's phone number.
  Future<String> _resolveEmployeeValue(String user) async {
    final normalizedUser = _normalizeUser(user);
    final userPhone = _extractShuttlePhone(user);
    final displayName = ref.read(chatStoreProvider.notifier).getDisplayName(user).trim();
    final preferredFullName = _normalizeShuttleEmployeeName(displayName);

    final employees = await _fetchShuttleEmployeesCached();
    if (employees.isNotEmpty) {
      final exact = employees.firstWhere(
        (entry) => _normalizeUser(entry) == normalizedUser,
        orElse: () => '',
      );
      if (exact.isNotEmpty) {
        return _formatShuttleEmployeeLabel(
          exact,
          userPhone.isNotEmpty ? userPhone : normalizedUser,
          preferredFullName,
        );
      }
      if (userPhone.isNotEmpty) {
        final byPhone = employees.firstWhere(
          (entry) => _extractShuttlePhone(entry) == userPhone,
          orElse: () => '',
        );
        if (byPhone.isNotEmpty) {
          return _formatShuttleEmployeeLabel(byPhone, userPhone, preferredFullName);
        }
      }
      if (displayName.isNotEmpty) {
        final normalizedDisplayName = _normalizeUser(displayName);
        final byName = employees.firstWhere(
          (entry) => _normalizeUser(entry).contains(normalizedDisplayName),
          orElse: () => '',
        );
        if (byName.isNotEmpty) {
          return _formatShuttleEmployeeLabel(
            byName,
            userPhone.isNotEmpty ? userPhone : normalizedUser,
            preferredFullName,
          );
        }
      }
    }

    if (preferredFullName.isNotEmpty &&
        userPhone.isNotEmpty &&
        !preferredFullName.contains(userPhone)) {
      return '$preferredFullName $userPhone';
    }
    if (preferredFullName.isNotEmpty) return preferredFullName;
    return user;
  }

  Future<List<String>> _fetchShuttleEmployeesCached() async {
    final cached = _employeesCache;
    if (cached != null) return cached;
    if (_currentUser == null || _currentUser!.isEmpty) return const [];
    try {
      final fetched = await _api.getShuttleEmployees(_currentUser!);
      _employeesCache = fetched;
      return fetched;
    } catch (_) {
      return const [];
    }
  }

  String _formatShuttleEmployeeLabel(
    String value,
    String fallbackPhone,
    String preferredName,
  ) {
    final phoneFromValue = _extractShuttlePhone(value);
    final normalizedPhone =
        phoneFromValue.isNotEmpty ? phoneFromValue : _extractShuttlePhone(fallbackPhone);
    final normalizedName = _normalizeShuttleEmployeeName(value);
    final preferred = _normalizeShuttleEmployeeName(preferredName);
    final bestName = _shuttleNameWordCount(normalizedName) >= 2
        ? normalizedName
        : (_shuttleNameWordCount(preferred) >= 2
            ? preferred
            : (normalizedName.isNotEmpty ? normalizedName : preferred));

    if (bestName.isNotEmpty && normalizedPhone.isNotEmpty) {
      return '$bestName $normalizedPhone';
    }
    if (bestName.isNotEmpty) return bestName;
    if (normalizedPhone.isNotEmpty) return normalizedPhone;
    return value.trim();
  }

  String _normalizeShuttleEmployeeName(String value) {
    final source = value.trim();
    if (source.isEmpty) return '';
    return source
        .replaceAll(RegExp(r'\([^)]*\)'), ' ')
        .replaceAll(RegExp(r'\d+'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
  }

  int _shuttleNameWordCount(String value) {
    final normalized = _normalizeShuttleEmployeeName(value);
    if (normalized.isEmpty) return 0;
    return normalized.split(RegExp(r'\s+')).where((s) => s.isNotEmpty).length;
  }

  String _extractShuttlePhone(String value) {
    final digits = value.replaceAll(RegExp(r'\D'), '');
    if (digits.isEmpty) return '';
    final embedded = RegExp(r'05\d{8}').firstMatch(digits);
    if (embedded != null) return embedded.group(0)!;
    if (RegExp(r'^5\d{8}$').hasMatch(digits)) return '0$digits';
    if (RegExp(r'^9725\d{8}$').hasMatch(digits)) return '0${digits.substring(3)}';
    if (RegExp(r'^97205\d{8}$').hasMatch(digits)) return '0${digits.substring(4)}';
    if (digits.length > 10) {
      final tail = digits.substring(digits.length - 10);
      if (RegExp(r'^05\d{8}$').hasMatch(tail)) return tail;
    }
    return '';
  }

  String _normalizeUser(String value) {
    return value.trim().toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Wizard Navigation Methods
  // ---------------------------------------------------------------------------
  
  /// Start a new order (move from menu to date selection)
  void startNewOrder() {
    state = state.copyWith(
      currentStep: ShuttleBookingStep.date,
      clearDate: true,
      clearShift: true,
      clearStation: true,
    );
  }
  
  /// Select a date and move to shift selection
  void selectDate(DateTime date) {
    state = state.copyWith(
      selectedDate: date,
      currentStep: ShuttleBookingStep.shift,
      clearShift: true,
      clearStation: true,
    );
  }
  
  /// Select a shift and move to station selection
  void selectShift(String shift) {
    state = state.copyWith(
      selectedShift: shift,
      currentStep: ShuttleBookingStep.station,
      clearStation: true,
    );
  }
  
  /// Select a station and submit the order
  Future<void> selectStationAndSubmit(String station) async {
    final date = state.selectedDate;
    final shiftSubmitValue = state.selectedShift;

    if (date == null || shiftSubmitValue == null) {
      state = state.copyWith(error: 'אנא בחר תאריך ומשמרת');
      return;
    }

    state = state.copyWith(selectedStation: station);

    // Mirror Angular's `submitShuttleOrder`: `date` is the picked day's ISO
    // date and `dateAlt` is today's ISO date.
    final dateIso = DateFormat('yyyy-MM-dd').format(date);
    final dateAltIso = DateFormat('yyyy-MM-dd').format(DateTime.now());

    await submitOrder(
      date: dateIso,
      dateAlt: dateAltIso,
      shift: shiftSubmitValue,
      station: station,
      status: shuttleStatusActiveValue,
    );
  }
  
  /// Go back to previous step
  void goBack() {
    switch (state.currentStep) {
      case ShuttleBookingStep.menu:
        // Already at menu, do nothing
        break;
      case ShuttleBookingStep.date:
        state = state.copyWith(
          currentStep: ShuttleBookingStep.menu,
          clearDate: true,
        );
        break;
      case ShuttleBookingStep.shift:
        state = state.copyWith(
          currentStep: ShuttleBookingStep.date,
          clearShift: true,
        );
        break;
      case ShuttleBookingStep.station:
        state = state.copyWith(
          currentStep: ShuttleBookingStep.shift,
          clearStation: true,
        );
        break;
    }
  }
  
  /// Reset wizard to initial state
  void resetWizard() {
    state = state.copyWith(
      currentStep: ShuttleBookingStep.menu,
      clearDate: true,
      clearShift: true,
      clearStation: true,
    );
  }
  
  /// Get available dates for shuttle booking (today + next 9 days), matching
  /// Angular's `getShuttleDateChoices` (starts at today).
  List<DateTime> getAvailableDates() {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final dates = <DateTime>[];
    for (int i = 0; i < 10; i++) {
      dates.add(today.add(Duration(days: i)));
    }
    return dates;
  }

  /// Get shift (departure-time) options, matching Angular's
  /// `getShuttleShiftOptionsForDate`. Same-day options whose time is less than
  /// 60 minutes from now are returned as disabled.
  List<({String label, String submitValue, bool disabled})>
      getShiftOptionsForDate(DateTime? date) {
    return shuttleShiftOptions.map((option) {
      return (
        label: option.label,
        submitValue: option.submitValue,
        disabled: _shouldDisableShiftForDate(date, option.label),
      );
    }).toList();
  }

  bool _shouldDisableShiftForDate(DateTime? date, String shiftLabel) {
    if (date == null) return false;
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final picked = DateTime(date.year, date.month, date.day);
    if (picked != today) return false;
    final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(shiftLabel.trim());
    if (m == null) return false;
    final shiftMinutes = int.parse(m.group(1)!) * 60 + int.parse(m.group(2)!);
    final minimumAllowedMinutes = now.hour * 60 + now.minute + 60;
    return shiftMinutes <= minimumAllowedMinutes;
  }

  // ---------------------------------------------------------------------------
  // Language helpers (mirrors Angular's shuttleText / setShuttleLanguage)
  // ---------------------------------------------------------------------------

  /// Toggle between Hebrew and Russian UI language.
  void setLanguage(ShuttleLanguage lang) {
    state = state.copyWith(language: lang);
  }

  /// Return [he] or [ru] depending on the current UI language.
  String text(String he, String ru) =>
      state.language == ShuttleLanguage.ru ? ru : he;

  /// Return the day-name for [date] in the current UI language.
  String dayName(DateTime date) {
    final names =
        state.language == ShuttleLanguage.ru ? _kDayNamesRu : _kDayNamesHe;
    return names[date.weekday % 7];
  }
}

final shuttleProvider = NotifierProvider<ShuttleNotifier, ShuttleState>(() {
  return ShuttleNotifier();
});

// ---------------------------------------------------------------------------
// Shuttle Screen
// ---------------------------------------------------------------------------

class ShuttleScreen extends ConsumerStatefulWidget {
  const ShuttleScreen({super.key});

  @override
  ConsumerState<ShuttleScreen> createState() => _ShuttleScreenState();
}

class _ShuttleScreenState extends ConsumerState<ShuttleScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    // Tab 0 = פעילות (ongoing), Tab 1 = עבר (past) — matches Angular order
    _tabController = TabController(length: 2, vsync: this);

    Future.microtask(() {
      ref.read(shuttleProvider.notifier).loadData();
    });

    _refreshTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) ref.read(shuttleProvider.notifier).loadUserOrders();
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _openNewOrderWizard() async {
    final notifier = ref.read(shuttleProvider.notifier);
    notifier.startNewOrder();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => const _BookingSheet(),
    );
    // If the user dismissed the sheet without finishing, reset the wizard.
    if (mounted) {
      final s = ref.read(shuttleProvider);
      if (s.currentStep != ShuttleBookingStep.menu) {
        ref.read(shuttleProvider.notifier).resetWizard();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(shuttleProvider);
    final notifier = ref.read(shuttleProvider.notifier);
    final theme = Theme.of(context);
    final now = DateTime.now();
    final dateHeader = DateFormat('dd.MM.yyyy').format(now);

    return Column(
      children: [
        // ── Error banner ──────────────────────────────────────────────────
        if (state.error != null)
          MaterialBanner(
            content: Text(state.error!),
            backgroundColor: theme.colorScheme.errorContainer,
            actions: [
              TextButton(
                onPressed: () => notifier.loadData(),
                child: Text(notifier.text('נסה שוב', 'Повторить')),
              ),
            ],
          ),

        // ── Header row: title (right) | refresh | language toggle (left) ──
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Row(
            children: [
              // Title on the right in RTL (first child = right side)
              Text(
                notifier.text('ההזמנות שלי', 'Мои заказы'),
                style: theme.textTheme.titleSmall
                    ?.copyWith(fontWeight: FontWeight.bold),
                textDirection: ui.TextDirection.rtl,
              ),
              const Spacer(),
              // Refresh button
              IconButton(
                onPressed: () => notifier.loadData(),
                icon: state.isLoading
                    ? SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: theme.colorScheme.primary,
                        ),
                      )
                    : const Icon(Icons.refresh),
                tooltip: notifier.text('רענן', 'Обновить'),
              ),
              const SizedBox(width: 6),
              // Language toggle on the left in RTL (last child = left side)
              _LangToggle(
                language: state.language,
                onChanged: notifier.setLanguage,
              ),
            ],
          ),
        ),

        // ── Today's date ──────────────────────────────────────────────────
        Text(
          dateHeader,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withAlpha(153),
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 4),

        // ── Tabs: פעילות (N) | עבר (N) ───────────────────────────────────
        TabBar(
          controller: _tabController,
          tabs: [
            Tab(
              text:
                  '${notifier.text('פעילות', 'Активные')} (${state.ongoingOrders.length})',
            ),
            Tab(
              text:
                  '${notifier.text('עבר', 'Прошедшие')} (${state.pastOrders.length})',
            ),
          ],
          labelColor: theme.colorScheme.primary,
          indicatorColor: theme.colorScheme.primary,
        ),

        // ── Orders list ───────────────────────────────────────────────────
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [
              _OrderList(
                orders: state.ongoingOrders,
                isPast: false,
                isLoading: state.isLoading && state.userOrders.isEmpty,
                emptyMessage:
                    notifier.text('אין הזמנות פעילות', 'Нет активных заказов'),
              ),
              _OrderList(
                orders: state.pastOrders,
                isPast: true,
                isLoading: state.isLoading && state.userOrders.isEmpty,
                emptyMessage:
                    notifier.text('אין הזמנות קודמות', 'Нет прошедших заказов'),
              ),
            ],
          ),
        ),

        // ── Bottom CTA: "הזמנה חדשה" ─────────────────────────────────────
        _BottomCta(onNewOrder: _openNewOrderWizard),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Language toggle widget (RU / עב)
// ---------------------------------------------------------------------------

class _LangToggle extends StatelessWidget {
  final ShuttleLanguage language;
  final void Function(ShuttleLanguage) onChanged;

  const _LangToggle({required this.language, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    Widget btn(String label, ShuttleLanguage value) {
      final selected = language == value;
      return GestureDetector(
        onTap: selected ? null : () => onChanged(value),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(
            color: selected
                ? theme.colorScheme.primary
                : theme.colorScheme.surface,
            borderRadius: value == ShuttleLanguage.ru
                ? const BorderRadius.only(
                    topLeft: Radius.circular(20),
                    bottomLeft: Radius.circular(20))
                : const BorderRadius.only(
                    topRight: Radius.circular(20),
                    bottomRight: Radius.circular(20)),
            border: Border.all(
              color: selected
                  ? theme.colorScheme.primary
                  : theme.colorScheme.outline,
            ),
          ),
          child: Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(
              color: selected
                  ? theme.colorScheme.onPrimary
                  : theme.colorScheme.onSurface,
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
      );
    }

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [btn('עב', ShuttleLanguage.he), btn('RU', ShuttleLanguage.ru)],
    );
  }
}

// ---------------------------------------------------------------------------
// Bottom CTA card ("הזמנה חדשה")
// ---------------------------------------------------------------------------

class _BottomCta extends ConsumerWidget {
  final VoidCallback onNewOrder;

  const _BottomCta({required this.onNewOrder});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final notifier = ref.read(shuttleProvider.notifier);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          top: BorderSide(
            color: theme.colorScheme.outlineVariant,
          ),
        ),
      ),
      child: Directionality(
        textDirection: ui.TextDirection.rtl,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              notifier.text('מה תרצה לבצע?', 'Что хотите сделать?'),
              style: theme.textTheme.titleSmall
                  ?.copyWith(fontWeight: FontWeight.bold),
            ),
            Text(
              notifier.text(
                'הזמנה חדשה בלחיצה אחת',
                'Новый заказ в одно нажатие',
              ),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurface.withAlpha(153),
              ),
            ),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: onNewOrder,
                child: Text(notifier.text('הזמנה חדשה', 'Новый заказ')),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Booking Wizard Bottom Sheet
// ---------------------------------------------------------------------------

class _BookingSheet extends ConsumerWidget {
  const _BookingSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(shuttleProvider);
    final notifier = ref.read(shuttleProvider.notifier);

    // Auto-close when submission completes (step returns to menu)
    ref.listen<ShuttleState>(shuttleProvider, (_, next) {
      if (next.currentStep == ShuttleBookingStep.menu && !next.isLoading) {
        if (context.mounted) Navigator.of(context).pop();
      }
    });

    final theme = Theme.of(context);

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      builder: (_, scrollController) {
        return Directionality(
          textDirection: ui.TextDirection.rtl,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Drag handle
              Container(
                margin: const EdgeInsets.symmetric(vertical: 8),
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: theme.colorScheme.outlineVariant,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              // Step title + back button
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Row(
                  children: [
                    if (state.canGoBack)
                      IconButton(
                        onPressed: notifier.goBack,
                        icon: const Icon(Icons.arrow_back_ios_new, size: 20),
                        tooltip: notifier.text('חזרה', 'Назад'),
                      ),
                    Expanded(
                      child: Text(
                        _stepTitle(state, notifier),
                        style: theme.textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.bold),
                        textAlign: TextAlign.center,
                      ),
                    ),
                    if (state.canGoBack) const SizedBox(width: 40),
                  ],
                ),
              ),
              const Divider(),
              // Step content
              Expanded(
                child: SingleChildScrollView(
                  controller: scrollController,
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _buildStepContent(context, ref, state, notifier, theme),
                      if (state.isLoading)
                        const Padding(
                          padding: EdgeInsets.all(24),
                          child: Center(child: CircularProgressIndicator()),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  String _stepTitle(ShuttleState state, ShuttleNotifier notifier) {
    switch (state.currentStep) {
      case ShuttleBookingStep.menu:
        return notifier.text('הזמנה חדשה', 'Новый заказ');
      case ShuttleBookingStep.date:
        return notifier.text('בחר תאריך נסיעה', 'Выберите дату поездки');
      case ShuttleBookingStep.shift:
        return notifier.text('בחר שעת נסיעה', 'Выберите смену');
      case ShuttleBookingStep.station:
        return notifier.text('בחר תחנה', 'Выберите станцию');
    }
  }

  Widget _buildStepContent(
    BuildContext context,
    WidgetRef ref,
    ShuttleState state,
    ShuttleNotifier notifier,
    ThemeData theme,
  ) {
    switch (state.currentStep) {
      case ShuttleBookingStep.menu:
        // Should not normally be visible (sheet auto-closes), but show a
        // fallback CTA in case of a race condition.
        return Center(
          child: Text(notifier.text('מעבד...', 'Обработка...')),
        );
      case ShuttleBookingStep.date:
        return _buildDateStep(context, notifier, state, theme);
      case ShuttleBookingStep.shift:
        return _buildShiftStep(context, state, notifier, theme);
      case ShuttleBookingStep.station:
        return _buildStationStep(context, ref, state, notifier, theme);
    }
  }

  Widget _buildDateStep(
    BuildContext context,
    ShuttleNotifier notifier,
    ShuttleState state,
    ThemeData theme,
  ) {
    final availableDates = notifier.getAvailableDates();

    return Column(
      children: [
        Text(
          notifier.text(
            'התאריכים זמינים ל-10 הימים הקרובים',
            'Доступны даты на ближайшие 10 дней',
          ),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withAlpha(153),
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          alignment: WrapAlignment.center,
          children: availableDates.map((date) {
            final name = notifier.dayName(date);
            final prefix = state.language == ShuttleLanguage.he ? 'יום ' : '';
            final dateStr = DateFormat('dd.MM').format(date);
            return OutlinedButton(
              onPressed: () => notifier.selectDate(date),
              style: OutlinedButton.styleFrom(
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '$prefix$name',
                    style: theme.textTheme.bodySmall,
                    textDirection: ui.TextDirection.rtl,
                  ),
                  Text(
                    dateStr,
                    style: theme.textTheme.bodyLarge
                        ?.copyWith(fontWeight: FontWeight.bold),
                  ),
                ],
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  Widget _buildShiftStep(
    BuildContext context,
    ShuttleState state,
    ShuttleNotifier notifier,
    ThemeData theme,
  ) {
    final shiftOptions = notifier.getShiftOptionsForDate(state.selectedDate);
    String dateLabel = '';
    if (state.selectedDate != null) {
      final name = notifier.dayName(state.selectedDate!);
      final prefix = state.language == ShuttleLanguage.he ? 'יום ' : '';
      dateLabel =
          '$prefix$name ${DateFormat('dd.MM.yyyy').format(state.selectedDate!)}';
    }
    final hasAnyEnabled = shiftOptions.any((o) => !o.disabled);

    return Column(
      children: [
        if (dateLabel.isNotEmpty)
          Text(
            dateLabel,
            style: theme.textTheme.bodyMedium
                ?.copyWith(color: theme.colorScheme.primary),
            textAlign: TextAlign.center,
            textDirection: ui.TextDirection.rtl,
          ),
        const SizedBox(height: 8),
        Text(
          notifier.text(
            'בחר אחת משעות ההסעה הזמינות',
            'Выберите одно из доступных времён трансфера',
          ),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withAlpha(153),
          ),
          textAlign: TextAlign.center,
          textDirection: ui.TextDirection.rtl,
        ),
        const SizedBox(height: 16),
        if (!hasAnyEnabled)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              notifier.text(
                'אין שעות זמינות בתאריך שנבחר. חזור ובחר תאריך אחר.',
                'Нет доступных времён в выбранную дату. Выберите другую дату.',
              ),
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.error),
              textAlign: TextAlign.center,
              textDirection: ui.TextDirection.rtl,
            ),
          ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          alignment: WrapAlignment.center,
          children: shiftOptions.map((option) {
            return OutlinedButton(
              onPressed: option.disabled
                  ? null
                  : () => notifier.selectShift(option.submitValue),
              style: OutlinedButton.styleFrom(
                padding:
                    const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
              ),
              child: Text(option.label,
                  style: theme.textTheme.titleMedium),
            );
          }).toList(),
        ),
      ],
    );
  }

  Widget _buildStationStep(
    BuildContext context,
    WidgetRef ref,
    ShuttleState state,
    ShuttleNotifier notifier,
    ThemeData theme,
  ) {
    return Column(
      children: [
        Text(
          notifier.text(
            'לחץ על הרשימה ובחר תחנה',
            'Выберите станцию из списка',
          ),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withAlpha(153),
          ),
          textAlign: TextAlign.center,
          textDirection: ui.TextDirection.rtl,
        ),
        const SizedBox(height: 16),
        DropdownButtonFormField<String>(
          decoration: InputDecoration(
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
            ),
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
            labelText: notifier.text('בחר תחנה', 'Выберите станцию'),
          ),
          hint: Text(
              notifier.text('בחר תחנה מהרשימה', 'Выберите станцию из списка')),
          items: state.stations.map((station) {
            return DropdownMenuItem(
              value: station,
              child:
                  Text(station, textDirection: ui.TextDirection.rtl),
            );
          }).toList(),
          onChanged: state.isLoading
              ? null
              : (value) async {
                  if (value != null) {
                    await notifier.selectStationAndSubmit(value);
                    if (context.mounted) {
                      showTopToast(
                        context,
                        notifier.text(
                          'ההזמנה נשלחה בהצלחה! ✅',
                          'Заказ успешно отправлен! ✅',
                        ),
                        backgroundColor: AppColors.success,
                      );
                    }
                  }
                },
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Combined order list widget
// ---------------------------------------------------------------------------

class _OrderList extends ConsumerWidget {
  final List<ShuttleUserOrderPayload> orders;
  final bool isPast;
  final bool isLoading;
  final String emptyMessage;

  const _OrderList({
    required this.orders,
    required this.isPast,
    required this.isLoading,
    required this.emptyMessage,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (isLoading) return const Center(child: CircularProgressIndicator());

    if (orders.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              isPast ? Icons.history : Icons.directions_bus_outlined,
              size: 60,
              color: Theme.of(context).colorScheme.primary.withAlpha(76),
            ),
            const SizedBox(height: 12),
            Text(
              emptyMessage,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withAlpha(153),
                  ),
              textDirection: ui.TextDirection.rtl,
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () => ref.read(shuttleProvider.notifier).loadUserOrders(),
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: orders.length,
        itemBuilder: (context, index) =>
            _OrderCard(order: orders[index], isPast: isPast),
      ),
    );
  }
}

class _OrderCard extends ConsumerStatefulWidget {
  final ShuttleUserOrderPayload order;
  final bool isPast;

  const _OrderCard({required this.order, required this.isPast});

  @override
  ConsumerState<_OrderCard> createState() => _OrderCardState();
}

class _OrderCardState extends ConsumerState<_OrderCard> {
  bool _isCancelling = false;

  /// Formats a raw date string (ISO `yyyy-MM-dd`, `dd/MM/yyyy`, or
  /// `dd.MM.yyyy`) to `dd.MM.yyyy`. Returns the original string unchanged if
  /// it cannot be parsed.
  String _formatOrderDate(String? raw) {
    if (raw == null || raw.trim().isEmpty) return '—';
    final s = raw.trim();
    // ISO yyyy-MM-dd
    final iso = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(s);
    if (iso != null) {
      return '${iso.group(3)}.${iso.group(2)}.${iso.group(1)}';
    }
    // dd/MM/yyyy or dd.MM.yyyy or dd-MM-yyyy
    final dmy = RegExp(r'^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$').firstMatch(s);
    if (dmy != null) {
      final d = dmy.group(1)!.padLeft(2, '0');
      final m = dmy.group(2)!.padLeft(2, '0');
      final y = dmy.group(3)!;
      return '$d.$m.$y';
    }
    return s;
  }

  @override
  Widget build(BuildContext context) {
    final order = widget.order;
    final isPast = widget.isPast;
    final theme = Theme.of(context);
    final canCancel = !isPast && !order.isCancelled && order.isOngoing;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      color: isPast 
          ? theme.colorScheme.surfaceContainerHighest.withAlpha((255 * 0.5).round())
          : null,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header with status and (for ongoing orders) a delete action.
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Row(
                    children: [
                      Icon(
                        order.isCancelled 
                            ? Icons.cancel 
                            : isPast 
                                ? Icons.check_circle 
                                : Icons.schedule,
                        size: 18,
                        color: order.isCancelled 
                            ? theme.colorScheme.error 
                            : isPast 
                                ? AppColors.success 
                                : theme.colorScheme.primary,
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          order.isCancelled 
                              ? 'בוטלה' 
                              : (order.statusValue ?? order.status ?? 'לא ידוע'),
                          style: TextStyle(
                            color: order.isCancelled 
                                ? theme.colorScheme.error 
                                : isPast 
                                    ? AppColors.success 
                                    : theme.colorScheme.primary,
                            fontWeight: FontWeight.bold,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
                if (order.dayName != null && order.dayName!.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    child: Text(
                      order.dayName!,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                      ),
                    ),
                  ),
                if (canCancel)
                  _isCancelling
                      ? const SizedBox(
                          width: 24,
                          height: 24,
                          child: Padding(
                            padding: EdgeInsets.all(4),
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                        )
                      : IconButton(
                          tooltip: 'מחק הזמנה',
                          icon: Icon(Icons.delete_outline, color: theme.colorScheme.error),
                          onPressed: () => _confirmAndCancel(context),
                        ),
              ],
            ),
            const Divider(height: 16),
            
            // Order details
            _OrderDetailRow(
              icon: Icons.calendar_today,
              label: 'תאריך',
              value: _formatOrderDate(order.dateIso ?? order.date),
            ),
            const SizedBox(height: 4),
            _OrderDetailRow(
              icon: Icons.access_time,
              label: 'שעה',
              value: order.shiftLabel ?? order.shift ?? '—',
            ),
            const SizedBox(height: 4),
            _OrderDetailRow(
              icon: Icons.location_on,
              label: 'תחנה',
              value: order.station ?? '—',
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmAndCancel(BuildContext context) async {
    final overlay = Overlay.of(context, rootOverlay: true);
    final errorColor = Theme.of(context).colorScheme.error;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => Directionality(
        textDirection: ui.TextDirection.rtl,
        child: AlertDialog(
          title: const Text('ביטול הזמנת הסעה'),
          content: const Text('האם לבטל את ההזמנה? פעולה זו אינה הפיכה.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('חזרה'),
            ),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: Theme.of(dialogContext).colorScheme.error,
              ),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('ביטול הזמנה'),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true) return;

    setState(() => _isCancelling = true);
    try {
      await ref.read(shuttleProvider.notifier).cancelOrder(widget.order);
      showTopToastOnOverlay(overlay, 'ההזמנה בוטלה בהצלחה ✅',
          backgroundColor: AppColors.success);
    } catch (e) {
      if (mounted) setState(() => _isCancelling = false);
      showTopToastOnOverlay(overlay, 'שגיאה בביטול הזמנה: ${e.toString()}',
          backgroundColor: errorColor);
    }
  }
}

class _OrderDetailRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _OrderDetailRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return Row(
      children: [
        Icon(icon, size: 16, color: theme.colorScheme.onSurface.withAlpha((255 * 0.5).round())),
        const SizedBox(width: 6),
        Text(
          '$label: ',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
          ),
        ),
        Text(
          value,
          style: theme.textTheme.bodyMedium,
        ),
      ],
    );
  }
}
