/// Helpdesk screen - support ticket management.
///
/// Allows users to create and view support tickets.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/models/helpdesk_models.dart';
import '../../../shared/theme/app_theme.dart';

// ---------------------------------------------------------------------------
// Helpdesk State
// ---------------------------------------------------------------------------

class HelpdeskState {
  final List<HelpdeskTicket> tickets;
  final bool isLoading;
  final String? error;

  const HelpdeskState({
    this.tickets = const [],
    this.isLoading = false,
    this.error,
  });

  HelpdeskState copyWith({
    List<HelpdeskTicket>? tickets,
    bool? isLoading,
    String? error,
  }) {
    return HelpdeskState(
      tickets: tickets ?? this.tickets,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpdesk Notifier
// ---------------------------------------------------------------------------

class HelpdeskNotifier extends StateNotifier<HelpdeskState> {
  final ChatApiService _api;

  HelpdeskNotifier(this._api) : super(const HelpdeskState());

  Future<void> loadTickets() async {
    state = state.copyWith(isLoading: true, error: null);

    try {
      final tickets = await _api.getHelpdeskTickets();
      state = state.copyWith(
        tickets: tickets,
        isLoading: false,
      );
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: 'שגיאה בטעינת פניות: ${e.toString()}',
      );
    }
  }

  Future<HelpdeskTicket> createTicket({
    required String subject,
    required String description,
    required String category,
    required String priority,
    String? location,
    String? phone,
    String? attachmentUrl,
  }) async {
    state = state.copyWith(isLoading: true, error: null);

    try {
      final ticket = await _api.createHelpdeskTicket(
        subject: subject,
        description: description,
        category: category,
        priority: priority,
        location: location,
        phone: phone,
        attachmentUrl: attachmentUrl,
      );
      await loadTickets();
      return ticket;
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: 'שגיאה ביצירת פנייה: ${e.toString()}',
      );
      rethrow;
    }
  }

  /// Load helpdesk locations for dropdown
  Future<List<String>> loadLocations() async {
    try {
      return await _api.getHelpdeskLocations();
    } catch (e) {
      return [];
    }
  }

  Future<void> addComment(String ticketId, String comment) async {
    try {
      await _api.addHelpdeskComment(ticketId, comment);
      await loadTickets();
    } catch (e) {
      state = state.copyWith(
        error: 'שגיאה בהוספת תגובה: ${e.toString()}',
      );
      rethrow;
    }
  }
}

final helpdeskProvider = StateNotifierProvider<HelpdeskNotifier, HelpdeskState>((ref) {
  final api = ref.watch(chatApiServiceProvider);
  return HelpdeskNotifier(api);
});

// ---------------------------------------------------------------------------
// Helpdesk Screen
// ---------------------------------------------------------------------------

class HelpdeskScreen extends ConsumerStatefulWidget {
  const HelpdeskScreen({super.key});

  @override
  ConsumerState<HelpdeskScreen> createState() => _HelpdeskScreenState();
}

class _HelpdeskScreenState extends ConsumerState<HelpdeskScreen> with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);

    // Load tickets on init
    Future.microtask(() {
      ref.read(helpdeskProvider.notifier).loadTickets();
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(helpdeskProvider);

    // Filter tickets by status
    final openTickets = state.tickets.where((t) => t.status == 'open').toList();
    final inProgressTickets = state.tickets.where((t) => t.status == 'in_progress').toList();
    final closedTickets = state.tickets.where((t) => t.status == 'resolved' || t.status == 'closed').toList();

    return Scaffold(
      body: Column(
        children: [
          // Tab bar
          TabBar(
            controller: _tabController,
            tabs: [
              Tab(text: 'פתוח (${openTickets.length})'),
              Tab(text: 'בטיפול (${inProgressTickets.length})'),
              Tab(text: 'סגור (${closedTickets.length})'),
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
                    ref.read(helpdeskProvider.notifier).loadTickets();
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
                _TicketList(tickets: openTickets, emptyMessage: 'אין פניות פתוחות'),
                _TicketList(tickets: inProgressTickets, emptyMessage: 'אין פניות בטיפול'),
                _TicketList(tickets: closedTickets, emptyMessage: 'אין פניות סגורות'),
              ],
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _showCreateTicketDialog(context),
        icon: const Icon(Icons.add),
        label: const Text('פנייה חדשה'),
      ),
    );
  }

  void _showCreateTicketDialog(BuildContext context) {
    final subjectController = TextEditingController();
    final descriptionController = TextEditingController();
    final locationController = TextEditingController();
    final phoneController = TextEditingController();
    String selectedCategory = 'general';
    String selectedPriority = 'normal';
    List<String> availableLocations = [];
    bool isLoadingLocations = true;

    // Load locations
    ref.read(helpdeskProvider.notifier).loadLocations().then((locations) {
      availableLocations = locations;
      isLoadingLocations = false;
    });

    showDialog(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) => AlertDialog(
          title: const Text('פנייה חדשה', textDirection: TextDirection.rtl),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Subject
                TextField(
                  controller: subjectController,
                  textDirection: TextDirection.rtl,
                  decoration: const InputDecoration(
                    labelText: 'נושא *',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),

                // Description
                TextField(
                  controller: descriptionController,
                  textDirection: TextDirection.rtl,
                  maxLines: 4,
                  decoration: const InputDecoration(
                    labelText: 'תיאור הבעיה *',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),

                // Location (autocomplete)
                Autocomplete<String>(
                  optionsBuilder: (textEditingValue) {
                    if (textEditingValue.text.isEmpty) {
                      return availableLocations;
                    }
                    return availableLocations.where((loc) =>
                        loc.toLowerCase().contains(textEditingValue.text.toLowerCase()));
                  },
                  onSelected: (value) {
                    locationController.text = value;
                  },
                  fieldViewBuilder: (context, controller, focusNode, onEditingComplete) {
                    return TextField(
                      controller: controller,
                      focusNode: focusNode,
                      onEditingComplete: onEditingComplete,
                      textDirection: TextDirection.rtl,
                      decoration: InputDecoration(
                        labelText: 'מיקום *',
                        border: const OutlineInputBorder(),
                        suffixIcon: isLoadingLocations
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: Padding(
                                  padding: EdgeInsets.all(8.0),
                                  child: CircularProgressIndicator(strokeWidth: 2),
                                ),
                              )
                            : null,
                      ),
                      onChanged: (value) {
                        locationController.text = value;
                      },
                    );
                  },
                ),
                const SizedBox(height: 16),

                // Phone
                TextField(
                  controller: phoneController,
                  textDirection: TextDirection.ltr,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(
                    labelText: 'טלפון ליצירת קשר',
                    border: OutlineInputBorder(),
                    hintText: '05X-XXXXXXX',
                  ),
                ),
                const SizedBox(height: 16),

                // Category dropdown
                DropdownButtonFormField<String>(
                  value: selectedCategory,
                  decoration: const InputDecoration(
                    labelText: 'קטגוריה',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(value: 'general', child: Text('כללי')),
                    DropdownMenuItem(value: 'technical', child: Text('טכני')),
                    DropdownMenuItem(value: 'billing', child: Text('חשבונות')),
                    DropdownMenuItem(value: 'feature', child: Text('בקשת תכונה')),
                  ],
                  onChanged: (value) {
                    setState(() => selectedCategory = value ?? 'general');
                  },
                ),
                const SizedBox(height: 16),

                // Priority dropdown
                DropdownButtonFormField<String>(
                  value: selectedPriority,
                  decoration: const InputDecoration(
                    labelText: 'דחיפות',
                    border: OutlineInputBorder(),
                  ),
                  items: const [
                    DropdownMenuItem(value: 'low', child: Text('נמוכה')),
                    DropdownMenuItem(value: 'normal', child: Text('רגילה')),
                    DropdownMenuItem(value: 'high', child: Text('גבוהה')),
                    DropdownMenuItem(value: 'urgent', child: Text('דחופה')),
                  ],
                  onChanged: (value) {
                    setState(() => selectedPriority = value ?? 'normal');
                  },
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('ביטול'),
            ),
            ElevatedButton(
              onPressed: () async {
                if (subjectController.text.trim().isEmpty) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('יש להזין נושא')),
                  );
                  return;
                }
                if (locationController.text.trim().isEmpty) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('יש להזין מיקום')),
                  );
                  return;
                }

                Navigator.of(context).pop();
                try {
                  await ref.read(helpdeskProvider.notifier).createTicket(
                        subject: subjectController.text.trim(),
                        description: descriptionController.text.trim(),
                        category: selectedCategory,
                        priority: selectedPriority,
                        location: locationController.text.trim().isEmpty
                            ? null
                            : locationController.text.trim(),
                        phone: phoneController.text.trim().isEmpty
                            ? null
                            : phoneController.text.trim(),
                      );
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('הפנייה נוצרה בהצלחה')),
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
              child: const Text('שלח'),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Ticket List
// ---------------------------------------------------------------------------

class _TicketList extends ConsumerWidget {
  final List<HelpdeskTicket> tickets;
  final String emptyMessage;

  const _TicketList({
    required this.tickets,
    required this.emptyMessage,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(helpdeskProvider);

    if (state.isLoading && tickets.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (tickets.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.support_agent_outlined,
              size: 80,
              color: Theme.of(context).colorScheme.primary.withAlpha((255 * 0.3).round()),
            ),
            const SizedBox(height: 16),
            Text(
              emptyMessage,
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
        await ref.read(helpdeskProvider.notifier).loadTickets();
      },
      child: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: tickets.length,
        itemBuilder: (context, index) {
          final ticket = tickets[index];
          return _TicketCard(ticket: ticket);
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Ticket Card
// ---------------------------------------------------------------------------

class _TicketCard extends StatelessWidget {
  final HelpdeskTicket ticket;

  const _TicketCard({required this.ticket});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: InkWell(
        onTap: () => _showTicketDetail(context),
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Subject and priority
              Row(
                children: [
                  Expanded(
                    child: Text(
                      ticket.subject,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  _PriorityBadge(priority: ticket.priority),
                ],
              ),
              const SizedBox(height: 8),

              // Description preview
              Text(
                ticket.description,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurface.withAlpha((255 * 0.7).round()),
                ),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              
              // Location (if available)
              if (ticket.location != null && ticket.location!.isNotEmpty) ...[
                const SizedBox(height: 8),
                Row(
                  children: [
                    Icon(
                      Icons.location_on,
                      size: 14,
                      color: theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                    ),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        ticket.location!,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurface.withAlpha((255 * 0.6).round()),
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
              ],
              const SizedBox(height: 12),

              // Meta info
              Row(
                children: [
                  _StatusBadge(status: ticket.status),
                  const Spacer(),
                  Icon(
                    Icons.access_time,
                    size: 14,
                    color: theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    DateFormat.yMd('he').add_Hm().format(ticket.createdAt),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withAlpha((255 * 0.5).round()),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showTicketDetail(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (context) => _TicketDetailScreen(ticket: ticket),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Status Badge
// ---------------------------------------------------------------------------

class _StatusBadge extends StatelessWidget {
  final String status;

  const _StatusBadge({required this.status});

  @override
  Widget build(BuildContext context) {
    Color color;
    String text;

    switch (status) {
      case 'open':
        color = Colors.blue;
        text = 'פתוח';
        break;
      case 'in_progress':
        color = AppColors.warning;
        text = 'בטיפול';
        break;
      case 'resolved':
        color = AppColors.success;
        text = 'נפתר';
        break;
      case 'closed':
        color = Colors.grey;
        text = 'סגור';
        break;
      default:
        color = Colors.grey;
        text = status;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withAlpha((255 * 0.1).round()),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontSize: 12,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Priority Badge
// ---------------------------------------------------------------------------

class _PriorityBadge extends StatelessWidget {
  final String priority;

  const _PriorityBadge({required this.priority});

  @override
  Widget build(BuildContext context) {
    Color color;
    IconData icon;

    switch (priority) {
      case 'low':
        color = Colors.green;
        icon = Icons.arrow_downward;
        break;
      case 'normal':
        color = Colors.blue;
        icon = Icons.remove;
        break;
      case 'high':
        color = Colors.orange;
        icon = Icons.arrow_upward;
        break;
      case 'urgent':
        color = Colors.red;
        icon = Icons.priority_high;
        break;
      default:
        color = Colors.grey;
        icon = Icons.help_outline;
    }

    return Icon(icon, size: 20, color: color);
  }
}

// ---------------------------------------------------------------------------
// Ticket Detail Screen
// ---------------------------------------------------------------------------

class _TicketDetailScreen extends ConsumerStatefulWidget {
  final HelpdeskTicket ticket;

  const _TicketDetailScreen({required this.ticket});

  @override
  ConsumerState<_TicketDetailScreen> createState() => _TicketDetailScreenState();
}

class _TicketDetailScreenState extends ConsumerState<_TicketDetailScreen> {
  final _commentController = TextEditingController();
  List<HelpdeskStatusHistory>? _history;
  bool _loadingHistory = false;

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    setState(() => _loadingHistory = true);
    try {
      final api = ref.read(chatApiServiceProvider);
      final history = await api.getTicketHistory(widget.ticket.id);
      setState(() {
        _history = history;
        _loadingHistory = false;
      });
    } catch (e) {
      setState(() => _loadingHistory = false);
    }
  }

  @override
  void dispose() {
    _commentController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Directionality(
      textDirection: TextDirection.rtl,
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            icon: const Icon(Icons.arrow_forward),
            onPressed: () => Navigator.of(context).pop(),
          ),
          title: Text('פנייה #${widget.ticket.id}'),
        ),
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Subject and status
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              widget.ticket.subject,
                              style: theme.textTheme.titleLarge?.copyWith(
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          _StatusBadge(status: widget.ticket.status),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          _PriorityBadge(priority: widget.ticket.priority),
                          const SizedBox(width: 8),
                          Text(_priorityText(widget.ticket.priority)),
                          const Spacer(),
                          Text(
                            DateFormat.yMd('he').add_Hm().format(widget.ticket.createdAt),
                            style: theme.textTheme.bodySmall,
                          ),
                        ],
                      ),
                      // Location
                      if (widget.ticket.location != null && widget.ticket.location!.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Icon(Icons.location_on, size: 16, color: theme.colorScheme.primary),
                            const SizedBox(width: 4),
                            Expanded(child: Text(widget.ticket.location!)),
                          ],
                        ),
                      ],
                      // Phone
                      if (widget.ticket.phone != null && widget.ticket.phone!.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Row(
                          children: [
                            Icon(Icons.phone, size: 16, color: theme.colorScheme.primary),
                            const SizedBox(width: 4),
                            Text(widget.ticket.phone!),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),

              // Attachment (if available)
              if (widget.ticket.attachmentUrl != null && widget.ticket.attachmentUrl!.isNotEmpty)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'קובץ מצורף',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 12),
                        InkWell(
                          onTap: () {
                            // Open attachment URL
                            // Could use url_launcher package
                          },
                          child: Row(
                            children: [
                              Icon(Icons.attach_file, color: theme.colorScheme.primary),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  'לחץ לצפייה בקובץ',
                                  style: TextStyle(
                                    color: theme.colorScheme.primary,
                                    decoration: TextDecoration.underline,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              if (widget.ticket.attachmentUrl != null && widget.ticket.attachmentUrl!.isNotEmpty)
                const SizedBox(height: 16),

              // Description
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'תיאור',
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(widget.ticket.description),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),

              // Status history
              if (_loadingHistory)
                const Center(child: CircularProgressIndicator())
              else if (_history != null && _history!.isNotEmpty) ...[
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'היסטוריית סטטוס',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 12),
                        ..._history!.map((h) => _buildHistoryItem(context, h)),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
              ],

              // Comments
              if (widget.ticket.comments.isNotEmpty) ...[
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'תגובות',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 12),
                        ...widget.ticket.comments.map((c) => _buildComment(context, c)),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
              ],

              // Add comment
              if (widget.ticket.status != 'closed')
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'הוסף תגובה',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: _commentController,
                          textDirection: TextDirection.rtl,
                          maxLines: 3,
                          decoration: const InputDecoration(
                            hintText: 'כתוב תגובה...',
                            border: OutlineInputBorder(),
                          ),
                        ),
                        const SizedBox(height: 12),
                        SizedBox(
                          width: double.infinity,
                          child: ElevatedButton(
                            onPressed: _addComment,
                            child: const Text('שלח'),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHistoryItem(BuildContext context, HelpdeskStatusHistory history) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: AppColors.primary,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  history.oldStatus != null
                      ? '${_statusText(history.oldStatus!)} → ${_statusText(history.newStatus)}'
                      : 'נוצרה כ-${_statusText(history.newStatus)}',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                Text(
                  '${history.changedBy} • ${DateFormat.yMd('he').add_Hm().format(history.createdAt)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildComment(BuildContext context, HelpdeskComment comment) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                comment.author,
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
              const Spacer(),
              Text(
                DateFormat.yMd('he').add_Hm().format(comment.createdAt),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(comment.content),
        ],
      ),
    );
  }

  Future<void> _addComment() async {
    final text = _commentController.text.trim();
    if (text.isEmpty) return;

    try {
      await ref.read(helpdeskProvider.notifier).addComment(widget.ticket.id, text);
      _commentController.clear();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('התגובה נוספה')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('שגיאה: ${e.toString()}'),
            backgroundColor: Theme.of(context).colorScheme.error,
          ),
        );
      }
    }
  }

  String _statusText(String status) {
    switch (status) {
      case 'open':
        return 'פתוח';
      case 'in_progress':
        return 'בטיפול';
      case 'resolved':
        return 'נפתר';
      case 'closed':
        return 'סגור';
      default:
        return status;
    }
  }

  String _priorityText(String priority) {
    switch (priority) {
      case 'low':
        return 'נמוכה';
      case 'normal':
        return 'רגילה';
      case 'high':
        return 'גבוהה';
      case 'urgent':
        return 'דחופה';
      default:
        return priority;
    }
  }
}
