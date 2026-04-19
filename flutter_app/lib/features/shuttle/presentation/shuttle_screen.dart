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
import '../../../shared/theme/app_theme.dart';
import '../../auth/presentation/auth_state.dart';

// ---------------------------------------------------------------------------
// Shuttle State
// ---------------------------------------------------------------------------

/// Shuttle booking state
class ShuttleState {
  final List<String> stations;
  final List<ShuttleUserOrderPayload> userOrders;
  final bool isLoading;
  final String? error;

  const ShuttleState({
    this.stations = const [],
    this.userOrders = const [],
    this.isLoading = false,
    this.error,
  });

  ShuttleState copyWith({
    List<String>? stations,
    List<ShuttleUserOrderPayload>? userOrders,
    bool? isLoading,
    String? error,
  }) {
    return ShuttleState(
      stations: stations ?? this.stations,
      userOrders: userOrders ?? this.userOrders,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
  
  /// Get ongoing orders
  List<ShuttleUserOrderPayload> get ongoingOrders => 
    userOrders.where((o) => o.isOngoing && !o.isCancelled).toList();
  
  /// Get past orders
  List<ShuttleUserOrderPayload> get pastOrders => 
    userOrders.where((o) => !o.isOngoing || o.isCancelled).toList();
}

// ---------------------------------------------------------------------------
// Shuttle Notifier
// ---------------------------------------------------------------------------

class ShuttleNotifier extends Notifier<ShuttleState> {
  late final ChatApiService _api;
  String? _currentUser;

  @override
  ShuttleState build() {
    _api = ref.watch(chatApiServiceProvider);
    _currentUser = ref.watch(currentUserProvider);
    return const ShuttleState();
  }

  Future<void> loadData() async {
    state = state.copyWith(isLoading: true, error: null);

    try {
      // Load stations and user orders in parallel
      final results = await Future.wait([
        _api.getShuttleStations(),
        _currentUser != null ? _api.getShuttleUserOrders(_currentUser!) : Future.value(<ShuttleUserOrderPayload>[]),
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
      final payload = ShuttleOrderSubmitPayload(
        employee: _currentUser!,
        date: date,
        dateAlt: dateAlt,
        shift: shift,
        station: station,
        status: status,
      );
      
      await _api.submitShuttleOrder(payload);
      await loadUserOrders();
      state = state.copyWith(isLoading: false);
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: 'שגיאה בשליחת הזמנה: ${e.toString()}',
      );
      rethrow;
    }
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
// New Order Tab
// ---------------------------------------------------------------------------

class _NewOrderTab extends ConsumerStatefulWidget {
  final ShuttleState state;

  const _NewOrderTab({required this.state});

  @override
  ConsumerState<_NewOrderTab> createState() => _NewOrderTabState();
}

class _NewOrderTabState extends ConsumerState<_NewOrderTab> {
  DateTime _selectedDate = DateTime.now().add(const Duration(days: 1));
  String? _selectedStation;
  String _selectedShift = 'morning'; // morning, evening

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final theme = Theme.of(context);

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
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: () => ref.read(shuttleProvider.notifier).loadData(),
              icon: const Icon(Icons.refresh),
              label: const Text('רענן'),
            ),
          ],
        ),
      );
    }

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'הזמנת הסעה חדשה',
                style: theme.textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 24),

              // Date picker
              _FormField(
                label: 'תאריך',
                child: InkWell(
                  onTap: () async {
                    final date = await showDatePicker(
                      context: context,
                      initialDate: _selectedDate,
                      firstDate: DateTime.now(),
                      lastDate: DateTime.now().add(const Duration(days: 30)),
                    );
                    if (date != null) {
                      setState(() => _selectedDate = date);
                    }
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                    decoration: BoxDecoration(
                      border: Border.all(color: theme.colorScheme.outline),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.calendar_today),
                        const SizedBox(width: 8),
                        Text(
                          DateFormat.yMMMd('he').format(_selectedDate),
                          style: theme.textTheme.bodyLarge,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),

              // Shift selection
              _FormField(
                label: 'משמרת',
                child: SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(value: 'morning', label: Text('בוקר')),
                    ButtonSegment(value: 'evening', label: Text('ערב')),
                  ],
                  selected: {_selectedShift},
                  onSelectionChanged: (selection) {
                    setState(() => _selectedShift = selection.first);
                  },
                ),
              ),
              const SizedBox(height: 16),

              // Station dropdown
              _FormField(
                label: 'תחנה',
                child: DropdownButtonFormField<String>(
                  value: _selectedStation,
                  decoration: InputDecoration(
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                  ),
                  hint: const Text('בחר תחנה'),
                  items: state.stations.map((station) {
                    return DropdownMenuItem(
                      value: station,
                      child: Text(station),
                    );
                  }).toList(),
                  onChanged: (value) {
                    setState(() => _selectedStation = value);
                  },
                ),
              ),
              const SizedBox(height: 24),

              // Submit button
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: _selectedStation != null && !state.isLoading
                      ? () => _submitOrder(context)
                      : null,
                  icon: state.isLoading 
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.directions_bus),
                  label: const Text('שלח הזמנה'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _submitOrder(BuildContext context) async {
    if (_selectedStation == null) return;

    final dateFormatted = DateFormat('dd/MM/yyyy').format(_selectedDate);
    final dateAlt = DateFormat('yyyy-MM-dd').format(_selectedDate);
    
    try {
      await ref.read(shuttleProvider.notifier).submitOrder(
        date: dateFormatted,
        dateAlt: dateAlt,
        shift: _selectedShift == 'morning' ? 'בוקר' : 'ערב',
        station: _selectedStation!,
        status: 'הזמנה חדשה',
      );
      
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('ההזמנה נשלחה בהצלחה!'),
            backgroundColor: AppColors.success,
          ),
        );
      }
    } catch (e) {
      // Error is handled by state
    }
  }
}

class _FormField extends StatelessWidget {
  final String label;
  final Widget child;

  const _FormField({required this.label, required this.child});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(height: 8),
        child,
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

class _OrderCard extends StatelessWidget {
  final ShuttleUserOrderPayload order;
  final bool isPast;

  const _OrderCard({required this.order, required this.isPast});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
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
            // Header with status
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
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
                    Text(
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
                    ),
                  ],
                ),
                if (order.dayName != null)
                  Text(
                    order.dayName!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                    ),
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
              label: 'משמרת',
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
