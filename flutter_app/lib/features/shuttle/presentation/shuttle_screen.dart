/// Shuttle screen - shuttle booking and status.
///
/// Allows users to book shuttle rides and view their bookings.
library;

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/models/api_payloads.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../shared/theme/app_theme.dart';
import '../../auth/presentation/auth_state.dart';

// ---------------------------------------------------------------------------
// Shuttle Booking Flow Step
// ---------------------------------------------------------------------------

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
    
    state = state.copyWith(isLoading: true, error: null);

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
      await loadUserOrders();
      state = state.copyWith(isLoading: false);
      // Reset wizard after successful submission
      resetWizard();
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
      await loadUserOrders();
      state = state.copyWith(isLoading: false);
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

class _ShuttleScreenState extends ConsumerState<ShuttleScreen> with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    
    // Load data on init
    Future.microtask(() {
      ref.read(shuttleProvider.notifier).loadData();
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(shuttleProvider);

    return Column(
      children: [
        // Tab bar
        TabBar(
          controller: _tabController,
          tabs: const [
            Tab(text: 'הזמנה חדשה'),
            Tab(text: 'ההזמנות שלי'),
          ],
        ),

        // Error banner
        if (state.error != null)
          MaterialBanner(
            content: Text(state.error!),
            backgroundColor: Theme.of(context).colorScheme.errorContainer,
            actions: [
              TextButton(
                onPressed: () {
                  ref.read(shuttleProvider.notifier).loadData();
                },
                child: const Text('נסה שוב'),
              ),
            ],
          ),

        // Tab content
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [
              _NewOrderTab(state: state),
              _OrdersTab(state: state),
            ],
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// New Order Tab (Wizard Flow)
// ---------------------------------------------------------------------------

class _NewOrderTab extends ConsumerWidget {
  final ShuttleState state;

  const _NewOrderTab({required this.state});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final notifier = ref.read(shuttleProvider.notifier);

    if (state.isLoading && state.stations.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (state.stations.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.directions_bus_outlined,
              size: 80,
              color: theme.colorScheme.primary.withAlpha((255 * 0.3).round()),
            ),
            const SizedBox(height: 16),
            Text(
              'אין תחנות זמינות',
              style: theme.textTheme.titleLarge?.copyWith(
                color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
              ),
              textDirection: ui.TextDirection.rtl,
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: () => notifier.loadData(),
              icon: const Icon(Icons.refresh),
              label: const Text('רענן'),
            ),
          ],
        ),
      );
    }

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          // Current step card
          _buildCurrentStepCard(context, ref, state, notifier),
          
          // Loading indicator
          if (state.isLoading)
            const Padding(
              padding: EdgeInsets.all(16),
              child: CircularProgressIndicator(),
            ),
        ],
      ),
    );
  }

  Widget _buildCurrentStepCard(
    BuildContext context,
    WidgetRef ref,
    ShuttleState state,
    ShuttleNotifier notifier,
  ) {
    final theme = Theme.of(context);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Step indicator (breadcrumbs)
            _buildBreadcrumbs(context, state),
            const SizedBox(height: 24),
            
            // Current step content
            _buildStepContent(context, ref, state, notifier, theme),
            
            // Back button
            if (state.canGoBack && !state.isLoading) ...[
              const SizedBox(height: 16),
              TextButton.icon(
                onPressed: () => notifier.goBack(),
                icon: const Icon(Icons.arrow_back),
                label: const Text('חזרה'),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildBreadcrumbs(BuildContext context, ShuttleState state) {
    final theme = Theme.of(context);
    final steps = [
      ('menu', 'התחלה', state.currentStep == ShuttleBookingStep.menu),
      ('date', 'תאריך', state.currentStep == ShuttleBookingStep.date),
      ('shift', 'שעה', state.currentStep == ShuttleBookingStep.shift),
      ('station', 'תחנה', state.currentStep == ShuttleBookingStep.station),
    ];

    final currentIndex = ShuttleBookingStep.values.indexOf(state.currentStep);

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        for (int i = 0; i < steps.length; i++) ...[
          if (i > 0)
            Container(
              width: 24,
              height: 2,
              color: i <= currentIndex 
                  ? theme.colorScheme.primary 
                  : theme.colorScheme.outline.withAlpha((255 * 0.3).round()),
            ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: i <= currentIndex 
                  ? theme.colorScheme.primary 
                  : theme.colorScheme.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: i <= currentIndex 
                    ? theme.colorScheme.primary 
                    : theme.colorScheme.outline,
              ),
            ),
            child: Text(
              steps[i].$2,
              style: theme.textTheme.bodySmall?.copyWith(
                color: i <= currentIndex 
                    ? theme.colorScheme.onPrimary 
                    : theme.colorScheme.onSurface,
                fontWeight: steps[i].$3 ? FontWeight.bold : FontWeight.normal,
              ),
            ),
          ),
        ],
      ],
    );
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
        return _buildMenuStep(context, notifier, theme);
      case ShuttleBookingStep.date:
        return _buildDateStep(context, notifier, theme);
      case ShuttleBookingStep.shift:
        return _buildShiftStep(context, state, notifier, theme);
      case ShuttleBookingStep.station:
        return _buildStationStep(context, ref, state, notifier, theme);
    }
  }

  Widget _buildMenuStep(BuildContext context, ShuttleNotifier notifier, ThemeData theme) {
    return Column(
      children: [
        Icon(
          Icons.directions_bus,
          size: 64,
          color: theme.colorScheme.primary,
        ),
        const SizedBox(height: 16),
        Text(
          'מה תרצה לבצע?',
          style: theme.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.bold,
          ),
          textAlign: TextAlign.center,
          textDirection: ui.TextDirection.rtl,
        ),
        const SizedBox(height: 8),
        Text(
          'הזמנה חדשה בלחיצה אחת',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
          ),
          textAlign: TextAlign.center,
          textDirection: ui.TextDirection.rtl,
        ),
        const SizedBox(height: 24),
        SizedBox(
          width: double.infinity,
          child: ElevatedButton.icon(
            onPressed: () => notifier.startNewOrder(),
            icon: const Icon(Icons.add),
            label: const Text('🚐 הזמנה חדשה'),
            style: ElevatedButton.styleFrom(
              padding: const EdgeInsets.symmetric(vertical: 16),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildDateStep(BuildContext context, ShuttleNotifier notifier, ThemeData theme) {
    final availableDates = notifier.getAvailableDates();
    final hebrewDays = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    
    return Column(
      children: [
        Text(
          'בחר תאריך נסיעה',
          style: theme.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.bold,
          ),
          textAlign: TextAlign.center,
          textDirection: ui.TextDirection.rtl,
        ),
        const SizedBox(height: 8),
        Text(
          'התאריכים זמינים ל-10 הימים הקרובים',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
          ),
          textAlign: TextAlign.center,
          textDirection: ui.TextDirection.rtl,
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          alignment: WrapAlignment.center,
          children: availableDates.map((date) {
            final dayName = hebrewDays[(date.weekday % 7)];
            final dateStr = DateFormat('dd/MM').format(date);
            return OutlinedButton(
              onPressed: () => notifier.selectDate(date),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'יום $dayName',
                    style: theme.textTheme.bodySmall,
                    textDirection: ui.TextDirection.rtl,
                  ),
                  Text(
                    dateStr,
                    style: theme.textTheme.bodyLarge?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  Widget _buildShiftStep(BuildContext context, ShuttleState state, ShuttleNotifier notifier, ThemeData theme) {
    final shiftOptions = notifier.getShiftOptionsForDate(state.selectedDate);
    final selectedDate = state.selectedDate;
    final hebrewDays = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    
    String dateLabel = '';
    if (selectedDate != null) {
      final dayName = hebrewDays[(selectedDate.weekday % 7)];
      dateLabel = 'יום $dayName ${DateFormat('dd/MM/yyyy').format(selectedDate)}';
    }

    final hasAnyEnabled = shiftOptions.any((option) => !option.disabled);

    return Column(
      children: [
        Text(
          'בחר שעת נסיעה',
          style: theme.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.bold,
          ),
          textAlign: TextAlign.center,
          textDirection: ui.TextDirection.rtl,
        ),
        const SizedBox(height: 8),
        if (dateLabel.isNotEmpty)
          Text(
            dateLabel,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.primary,
            ),
            textAlign: TextAlign.center,
            textDirection: ui.TextDirection.rtl,
          ),
        const SizedBox(height: 16),
        Text(
          'בחר אחת משעות ההסעה הזמינות',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
          ),
          textAlign: TextAlign.center,
          textDirection: ui.TextDirection.rtl,
        ),
        const SizedBox(height: 16),
        if (!hasAnyEnabled)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              'אין שעות זמינות בתאריך שנבחר. חזור ובחר תאריך אחר.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
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
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
              ),
              child: Text(
                option.label,
                style: theme.textTheme.titleMedium,
              ),
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
    final stations = state.stations;
    
    return Column(
      children: [
        Text(
          'בחר תחנה',
          style: theme.textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.bold,
          ),
          textAlign: TextAlign.center,
          textDirection: ui.TextDirection.rtl,
        ),
        const SizedBox(height: 8),
        Text(
          'לחץ על התחנה הרצויה',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
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
            contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
            labelText: 'בחר תחנה',
          ),
          hint: const Text('בחר תחנה מהרשימה'),
          items: stations.map((station) {
            return DropdownMenuItem(
              value: station,
              child: Text(station, textDirection: ui.TextDirection.rtl),
            );
          }).toList(),
          onChanged: state.isLoading ? null : (value) async {
            if (value != null) {
              await notifier.selectStationAndSubmit(value);
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('ההזמנה נשלחה בהצלחה!'),
                    backgroundColor: AppColors.success,
                  ),
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
// Orders Tab
// ---------------------------------------------------------------------------

class _OrdersTab extends ConsumerWidget {
  final ShuttleState state;

  const _OrdersTab({required this.state});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (state.isLoading && state.userOrders.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    final ongoingOrders = state.ongoingOrders;
    final pastOrders = state.pastOrders;

    if (ongoingOrders.isEmpty && pastOrders.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.directions_bus_outlined,
              size: 80,
              color: Theme.of(context).colorScheme.primary.withAlpha((255 * 0.3).round()),
            ),
            const SizedBox(height: 16),
            Text(
              'אין הזמנות',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.6).round()),
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () => ref.read(shuttleProvider.notifier).loadUserOrders(),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (ongoingOrders.isNotEmpty) ...[
            _SectionHeader(title: 'הזמנות פעילות', count: ongoingOrders.length),
            ...ongoingOrders.map((order) => _OrderCard(order: order, isPast: false)),
            const SizedBox(height: 16),
          ],
          if (pastOrders.isNotEmpty) ...[
            _SectionHeader(title: 'הזמנות קודמות', count: pastOrders.length),
            ...pastOrders.map((order) => _OrderCard(order: order, isPast: true)),
          ],
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String title;
  final int count;

  const _SectionHeader({required this.title, required this.count});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Text(
            title,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.primaryContainer,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(
              '$count',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onPrimaryContainer,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _OrderCard extends ConsumerWidget {
  final ShuttleUserOrderPayload order;
  final bool isPast;

  const _OrderCard({required this.order, required this.isPast});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
                  IconButton(
                    tooltip: 'מחק הזמנה',
                    icon: Icon(Icons.delete_outline, color: theme.colorScheme.error),
                    onPressed: () => _confirmAndCancel(context, ref),
                  ),
              ],
            ),
            const Divider(height: 16),
            
            // Order details
            _OrderDetailRow(
              icon: Icons.calendar_today,
              label: 'תאריך',
              value: order.date ?? '—',
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

  Future<void> _confirmAndCancel(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
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

    try {
      await ref.read(shuttleProvider.notifier).cancelOrder(order);
      messenger.showSnackBar(
        const SnackBar(
          content: Text('ההזמנה בוטלה בהצלחה ✅'),
          backgroundColor: AppColors.success,
        ),
      );
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(
          content: Text('שגיאה בביטול הזמנה: ${e.toString()}'),
          backgroundColor: errorColor,
        ),
      );
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
