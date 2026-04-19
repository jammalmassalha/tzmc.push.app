/// Shuttle screen - shuttle booking and status.
///
/// Allows users to book shuttle rides and view their bookings.
library;

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/models/models.dart';
import '../../../shared/theme/app_theme.dart';

// ---------------------------------------------------------------------------
// Shuttle State
// ---------------------------------------------------------------------------

/// Shuttle booking state
class ShuttleState {
  final List<ShuttleRoute> routes;
  final List<ShuttleBooking> userBookings;
  final bool isLoading;
  final String? error;

  const ShuttleState({
    this.routes = const [],
    this.userBookings = const [],
    this.isLoading = false,
    this.error,
  });

  ShuttleState copyWith({
    List<ShuttleRoute>? routes,
    List<ShuttleBooking>? userBookings,
    bool? isLoading,
    String? error,
  }) {
    return ShuttleState(
      routes: routes ?? this.routes,
      userBookings: userBookings ?? this.userBookings,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
}

/// Shuttle route model
class ShuttleRoute {
  final String id;
  final String name;
  final String description;
  final String departureTime;
  final String arrivalTime;
  final int availableSeats;
  final int totalSeats;

  const ShuttleRoute({
    required this.id,
    required this.name,
    required this.description,
    required this.departureTime,
    required this.arrivalTime,
    required this.availableSeats,
    required this.totalSeats,
  });

  factory ShuttleRoute.fromJson(Map<String, dynamic> json) {
    return ShuttleRoute(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      description: json['description']?.toString() ?? '',
      departureTime: json['departureTime']?.toString() ?? '',
      arrivalTime: json['arrivalTime']?.toString() ?? '',
      availableSeats: json['availableSeats'] as int? ?? 0,
      totalSeats: json['totalSeats'] as int? ?? 0,
    );
  }
}

/// Shuttle booking model
class ShuttleBooking {
  final String id;
  final String routeId;
  final String routeName;
  final DateTime date;
  final String status; // 'pending', 'confirmed', 'cancelled'
  final int passengers;

  const ShuttleBooking({
    required this.id,
    required this.routeId,
    required this.routeName,
    required this.date,
    required this.status,
    required this.passengers,
  });

  factory ShuttleBooking.fromJson(Map<String, dynamic> json) {
    return ShuttleBooking(
      id: json['id']?.toString() ?? '',
      routeId: json['routeId']?.toString() ?? '',
      routeName: json['routeName']?.toString() ?? '',
      date: DateTime.tryParse(json['date']?.toString() ?? '') ?? DateTime.now(),
      status: json['status']?.toString() ?? 'pending',
      passengers: json['passengers'] as int? ?? 1,
    );
  }
}

// ---------------------------------------------------------------------------
// Shuttle Notifier
// ---------------------------------------------------------------------------

class ShuttleNotifier extends Notifier<ShuttleState> {
  late final ChatApiService _api;

  @override
  ShuttleState build() {
    _api = ref.watch(chatApiServiceProvider);
    return const ShuttleState();
  }

  Future<void> loadRoutes() async {
    state = state.copyWith(isLoading: true, error: null);

    try {
      final routes = await _api.getShuttleRoutes();
      state = state.copyWith(
        routes: routes.map((r) => ShuttleRoute.fromJson(r)).toList(),
        isLoading: false,
      );
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: 'שגיאה בטעינת מסלולים: ${e.toString()}',
      );
    }
  }

  Future<void> loadUserBookings() async {
    try {
      final bookings = await _api.getShuttleUserBookings();
      state = state.copyWith(
        userBookings: bookings.map((b) => ShuttleBooking.fromJson(b)).toList(),
      );
    } catch (e) {
      // Silent failure for user bookings
    }
  }

  Future<void> bookShuttle({
    required String routeId,
    required DateTime date,
    required int passengers,
  }) async {
    state = state.copyWith(isLoading: true, error: null);

    try {
      await _api.bookShuttle(
        routeId: routeId,
        date: date.toIso8601String(),
        passengers: passengers,
      );
      await loadUserBookings();
      state = state.copyWith(isLoading: false);
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: 'שגיאה בהזמנה: ${e.toString()}',
      );
      rethrow;
    }
  }

  Future<void> cancelBooking(String bookingId) async {
    try {
      await _api.cancelShuttleBooking(bookingId);
      await loadUserBookings();
    } catch (e) {
      state = state.copyWith(
        error: 'שגיאה בביטול: ${e.toString()}',
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
      ref.read(shuttleProvider.notifier).loadRoutes();
      ref.read(shuttleProvider.notifier).loadUserBookings();
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
                  ref.read(shuttleProvider.notifier).loadRoutes();
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
              _RoutesTab(state: state),
              _BookingsTab(state: state),
            ],
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Routes Tab
// ---------------------------------------------------------------------------

class _RoutesTab extends ConsumerWidget {
  final ShuttleState state;

  const _RoutesTab({required this.state});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (state.isLoading && state.routes.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (state.routes.isEmpty) {
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
              'אין מסלולים זמינים',
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                    color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                  ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async {
        await ref.read(shuttleProvider.notifier).loadRoutes();
      },
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: state.routes.length,
        itemBuilder: (context, index) {
          final route = state.routes[index];
          return _RouteCard(route: route);
        },
      ),
    );
  }
}

class _RouteCard extends ConsumerWidget {
  final ShuttleRoute route;

  const _RouteCard({required this.route});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final hasSeats = route.availableSeats > 0;

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Route name and seats
            Row(
              children: [
                Expanded(
                  child: Text(
                    route.name,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: hasSeats ? AppColors.success.withAlpha((255 * 0.1).round()) : Colors.red.withAlpha((255 * 0.1).round()),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    '${route.availableSeats}/${route.totalSeats} מקומות',
                    style: TextStyle(
                      color: hasSeats ? AppColors.success : Colors.red,
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Description
            Text(
              route.description,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurface.withAlpha((255 * 0.7).round()),
              ),
            ),
            const SizedBox(height: 12),

            // Times
            Row(
              children: [
                Icon(Icons.schedule, size: 16, color: theme.colorScheme.primary),
                const SizedBox(width: 4),
                Text('יציאה: ${route.departureTime}'),
                const SizedBox(width: 16),
                const Icon(Icons.arrow_forward, size: 16),
                const SizedBox(width: 4),
                Text('הגעה: ${route.arrivalTime}'),
              ],
            ),
            const SizedBox(height: 12),

            // Book button
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: hasSeats ? () => _showBookingDialog(context, ref) : null,
                icon: const Icon(Icons.directions_bus),
                label: const Text('הזמן מקום'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showBookingDialog(BuildContext context, WidgetRef ref) {
    DateTime selectedDate = DateTime.now();
    int passengers = 1;

    showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) => AlertDialog(
          title: Text('הזמנת הסעה - ${route.name}', textDirection: ui.TextDirection.rtl),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Date picker
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.calendar_today),
                title: const Text('תאריך'),
                subtitle: Text(DateFormat.yMMMd('he').format(selectedDate)),
                onTap: () async {
                  final date = await showDatePicker(
                    context: context,
                    initialDate: selectedDate,
                    firstDate: DateTime.now(),
                    lastDate: DateTime.now().add(const Duration(days: 30)),
                  );
                  if (date != null) {
                    setState(() => selectedDate = date);
                  }
                },
              ),
              const SizedBox(height: 8),

              // Passengers
              Row(
                children: [
                  const Icon(Icons.person),
                  const SizedBox(width: 8),
                  const Text('מספר נוסעים:'),
                  const Spacer(),
                  IconButton(
                    icon: const Icon(Icons.remove_circle_outline),
                    onPressed: passengers > 1
                        ? () => setState(() => passengers--)
                        : null,
                  ),
                  Text('$passengers', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  IconButton(
                    icon: const Icon(Icons.add_circle_outline),
                    onPressed: passengers < route.availableSeats
                        ? () => setState(() => passengers++)
                        : null,
                  ),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('ביטול'),
            ),
            ElevatedButton(
              onPressed: () async {
                Navigator.of(context).pop();
                try {
                  await ref.read(shuttleProvider.notifier).bookShuttle(
                        routeId: route.id,
                        date: selectedDate,
                        passengers: passengers,
                      );
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('ההזמנה נשלחה בהצלחה!')),
                    );
                  }
                } catch (e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text('שגיאה: ${e.toString()}'),
                        backgroundColor: Theme.of(context).colorScheme.error,
                      ),
                    );
                  }
                }
              },
              child: const Text('הזמן'),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Bookings Tab
// ---------------------------------------------------------------------------

class _BookingsTab extends ConsumerWidget {
  final ShuttleState state;

  const _BookingsTab({required this.state});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (state.isLoading && state.userBookings.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (state.userBookings.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.event_available,
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
            const SizedBox(height: 8),
            Text(
              'הזמנות שלך יופיעו כאן',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurface.withAlpha((255 * 0.4).round()),
                  ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async {
        await ref.read(shuttleProvider.notifier).loadUserBookings();
      },
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: state.userBookings.length,
        itemBuilder: (context, index) {
          final booking = state.userBookings[index];
          return _BookingCard(booking: booking);
        },
      ),
    );
  }
}

class _BookingCard extends ConsumerWidget {
  final ShuttleBooking booking;

  const _BookingCard({required this.booking});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final isPast = booking.date.isBefore(DateTime.now());
    final isCancelled = booking.status == 'cancelled';

    Color statusColor;
    String statusText;
    switch (booking.status) {
      case 'confirmed':
        statusColor = AppColors.success;
        statusText = 'מאושר';
        break;
      case 'cancelled':
        statusColor = Colors.red;
        statusText = 'בוטל';
        break;
      default:
        statusColor = AppColors.warning;
        statusText = 'ממתין';
    }

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Route name and status
            Row(
              children: [
                Expanded(
                  child: Text(
                    booking.routeName,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                      color: isPast || isCancelled
                          ? theme.colorScheme.onSurface.withAlpha((255 * 0.5).round())
                          : null,
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: statusColor.withAlpha((255 * 0.1).round()),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    statusText,
                    style: TextStyle(
                      color: statusColor,
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Date and passengers
            Row(
              children: [
                Icon(Icons.calendar_today, size: 16, color: theme.colorScheme.primary),
                const SizedBox(width: 4),
                Text(DateFormat.yMMMd('he').format(booking.date)),
                const SizedBox(width: 16),
                Icon(Icons.person, size: 16, color: theme.colorScheme.primary),
                const SizedBox(width: 4),
                Text('${booking.passengers} נוסעים'),
              ],
            ),

            // Cancel button (only for future, non-cancelled bookings)
            if (!isPast && !isCancelled) ...[
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: () => _confirmCancel(context, ref),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.red,
                  ),
                  child: const Text('בטל הזמנה'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  void _confirmCancel(BuildContext context, WidgetRef ref) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('ביטול הזמנה', textDirection: ui.TextDirection.rtl),
        content: const Text('האם אתה בטוח שברצונך לבטל הזמנה זו?', textDirection: ui.TextDirection.rtl),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('לא'),
          ),
          TextButton(
            onPressed: () async {
              Navigator.of(context).pop();
              try {
                await ref.read(shuttleProvider.notifier).cancelBooking(booking.id);
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('ההזמנה בוטלה')),
                  );
                }
              } catch (e) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text('שגיאה: ${e.toString()}'),
                      backgroundColor: Theme.of(context).colorScheme.error,
                    ),
                  );
                }
              }
            },
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('בטל'),
          ),
        ],
      ),
    );
  }
}
