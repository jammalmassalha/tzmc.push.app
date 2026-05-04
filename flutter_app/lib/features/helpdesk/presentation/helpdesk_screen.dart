/// Helpdesk screen - support ticket management.
///
/// Allows users to create and view support tickets.
library;

import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart' as img_picker;
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/models/helpdesk_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/utils/xfile.dart' as xfile;
import '../../auth/presentation/auth_state.dart';
import '../../../core/utils/toast_utils.dart';

// ---------------------------------------------------------------------------
// Helpdesk State
// ---------------------------------------------------------------------------

/// Status values that count as "ongoing" tickets in the Angular workflow
/// (chat-store.service.ts `ongoingStatuses`). Anything else is considered
/// "past" so that no tickets are silently dropped from the UI.
const Set<String> kHelpdeskOngoingStatuses = {'open', 'in_progress'};

class HelpdeskState {
  final List<HelpdeskTicket> ongoing;
  final List<HelpdeskTicket> past;
  final List<HelpdeskTicket> assigned;
  final HelpdeskMyRole? myRole;
  final List<HelpdeskTicket> editorTickets;
  final List<HelpdeskManagedUser> handlers;
  final bool isLoading;
  final String? error;

  const HelpdeskState({
    this.ongoing = const [],
    this.past = const [],
    this.assigned = const [],
    this.myRole,
    this.editorTickets = const [],
    this.handlers = const [],
    this.isLoading = false,
    this.error,
  });

  /// All tickets combined (kept for backwards-compatible callers).
  List<HelpdeskTicket> get tickets => [...ongoing, ...past, ...assigned];

  HelpdeskState copyWith({
    List<HelpdeskTicket>? ongoing,
    List<HelpdeskTicket>? past,
    List<HelpdeskTicket>? assigned,
    HelpdeskMyRole? myRole,
    bool clearMyRole = false,
    List<HelpdeskTicket>? editorTickets,
    List<HelpdeskManagedUser>? handlers,
    bool? isLoading,
    String? error,
  }) {
    return HelpdeskState(
      ongoing: ongoing ?? this.ongoing,
      past: past ?? this.past,
      assigned: assigned ?? this.assigned,
      myRole: clearMyRole ? null : (myRole ?? this.myRole),
      editorTickets: editorTickets ?? this.editorTickets,
      handlers: handlers ?? this.handlers,
      isLoading: isLoading ?? this.isLoading,
      error: error,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpdesk Notifier
// ---------------------------------------------------------------------------

class HelpdeskNotifier extends Notifier<HelpdeskState> {
  late final ChatApiService _api;
  String? _currentUser;

  /// Polling cadence for refreshing the helpdesk dashboard while this screen
  /// is mounted. Mirrors `startHelpdeskPolling` in chat-store.service.ts;
  /// Angular uses 20s (`HELPDESK_TICKETS_POLL_INTERVAL_MS`). We use 15s here
  /// per the mobile spec — slightly snappier feedback when a handler closes a
  /// ticket from the web client.
  static const Duration _pollInterval = Duration(seconds: 15);

  /// Short cache TTL to coalesce duplicate calls when the tab is re-entered.
  /// Conceptually mirrors `HELPDESK_TICKETS_CACHE_TTL_MS` (60s in Angular),
  /// but kept very short on mobile so manual refreshes / tab switches are not
  /// silently ignored. The polling timer above is the long-running source of
  /// freshness, so this only deduplicates rapid back-to-back calls.
  static const Duration _cacheTtl = Duration(seconds: 2);

  Timer? _pollTimer;
  DateTime? _lastLoadAt;
  Future<void>? _inflight;

  @override
  HelpdeskState build() {
    _api = ref.watch(chatApiServiceProvider);
    _currentUser = ref.watch(currentUserProvider);

    _pollTimer?.cancel();
    if (_currentUser != null) {
      _pollTimer = Timer.periodic(_pollInterval, (_) {
        // Force a refresh on the polling cadence, ignoring the cache TTL.
        loadTickets(force: true);
      });
    }
    ref.onDispose(() {
      _pollTimer?.cancel();
      _pollTimer = null;
    });

    return const HelpdeskState();
  }

  Future<void> loadTickets({bool force = false}) async {
    if (_currentUser == null) {
      state = state.copyWith(
        isLoading: false,
        error: 'יש להתחבר תחילה',
      );
      return;
    }

    // Cache TTL: skip if we just loaded recently (mirrors Angular's
    // HELPDESK_TICKETS_CACHE_TTL_MS guard around forceRefreshHelpdeskTickets).
    final now = DateTime.now();
    if (!force && _lastLoadAt != null && now.difference(_lastLoadAt!) < _cacheTtl) {
      return;
    }

    // De-duplicate concurrent calls.
    final inflight = _inflight;
    if (inflight != null) {
      return inflight;
    }

    final future = _doLoad();
    _inflight = future;
    try {
      await future;
    } finally {
      _inflight = null;
    }
  }

  Future<void> _doLoad() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final dashboard = await _api.getHelpdeskDashboard(_currentUser!);
      _lastLoadAt = DateTime.now();
      state = HelpdeskState(
        ongoing: dashboard.ongoing,
        past: dashboard.past,
        assigned: dashboard.assigned,
        myRole: dashboard.myRole,
        editorTickets: dashboard.editorTickets ?? const [],
        handlers: dashboard.handlers ?? const [],
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
    required HelpdeskDepartment department,
    required String priority,
    String? location,
    String? phone,
    String? attachmentUrl,
  }) async {
    if (_currentUser == null) {
      throw Exception('יש להתחבר תחילה');
    }
    
    state = state.copyWith(isLoading: true, error: null);

    try {
      final ticket = await _api.createHelpdeskTicket(
        user: _currentUser!,
        subject: subject,
        description: description,
        department: department,
        priority: priority,
        location: location,
        phone: phone,
        attachmentUrl: attachmentUrl,
      );
      await loadTickets(force: true);
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
    if (_currentUser == null) return [];
    
    try {
      return await _api.getHelpdeskLocations(_currentUser!);
    } catch (e) {
      return [];
    }
  }

  Future<void> addComment(String ticketId, String comment) async {
    if (_currentUser == null) {
      throw Exception('יש להתחבר תחילה');
    }
    
    try {
      await _api.addHelpdeskComment(ticketId, comment, _currentUser!);
      await loadTickets(force: true);
    } catch (e) {
      state = state.copyWith(
        error: 'שגיאה בהוספת תגובה: ${e.toString()}',
      );
      rethrow;
    }
  }

  /// Assign (or unassign) a handler to a ticket. Editor/Admin only.
  Future<void> assignHandler(int ticketId, String? handlerUsername) async {
    if (_currentUser == null) throw Exception('יש להתחבר תחילה');
    await _api.assignHelpdeskHandler(ticketId, handlerUsername, _currentUser!);
    await loadTickets(force: true);
  }

  /// Update the status of a ticket.
  Future<void> updateTicketStatus(int ticketId, String status) async {
    if (_currentUser == null) throw Exception('יש להתחבר תחילה');
    final helpdeskStatus = HelpdeskStatus.fromString(status);
    await _api.updateHelpdeskTicketStatus(ticketId, helpdeskStatus, _currentUser!);
    await loadTickets(force: true);
  }

  String get currentUser => _currentUser ?? '';
}

final helpdeskProvider = NotifierProvider<HelpdeskNotifier, HelpdeskState>(() {
  return HelpdeskNotifier();
});


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

String _statusLabel(String status) {
  switch (status) {
    case 'open':
      return 'פתוחה';
    case 'in_progress':
      return 'בטיפול';
    case 'resolved':
      return 'טופלה';
    case 'closed':
      return 'סגורה';
    default:
      return status;
  }
}

Color _statusColor(String status) {
  switch (status) {
    case 'open':
      return const Color(0xFF2E7D32); // green.shade800
    case 'in_progress':
      return const Color(0xFFE65100); // deepOrange.shade900
    case 'resolved':
      return const Color(0xFF1565C0); // blue.shade900
    case 'closed':
      return const Color(0xFF757575); // grey.shade600
    default:
      return const Color(0xFF757575);
  }
}

String _totalDurationLabel(List<HelpdeskStatusHistoryEntry> history) {
  if (history.isEmpty) return '';
  // History is ordered newest-first (DESC). The opening entry is the last one.
  final openTime = history.last.createdAt;
  HelpdeskStatusHistoryEntry? closedEntry;
  // Iterate from newest to oldest to find the most recent closed/resolved entry.
  for (final h in history) {
    if (h.newStatus == 'closed' || h.newStatus == 'resolved') {
      closedEntry = h;
      break;
    }
  }
  final endTime = closedEntry?.createdAt ?? DateTime.now();
  final diff = endTime.difference(openTime);
  if (diff.isNegative) return '';
  final days = diff.inDays;
  final hours = diff.inHours % 24;
  final mins = diff.inMinutes % 60;
  if (days > 0) return '$days ימים, $hours שעות, $mins דקות';
  if (hours > 0) return '$hours שעות, $mins דקות';
  return '$mins דקות';
}

// ---------------------------------------------------------------------------
// Helpdesk Screen ('מוקד איחוד') — user-facing: open and view own tickets
// ---------------------------------------------------------------------------

class HelpdeskScreen extends ConsumerStatefulWidget {
  const HelpdeskScreen({super.key});

  @override
  ConsumerState<HelpdeskScreen> createState() => _HelpdeskScreenState();
}

class _HelpdeskScreenState extends ConsumerState<HelpdeskScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    Future.microtask(() {
      ref.read(helpdeskProvider.notifier).loadTickets(force: true);
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
    final theme = Theme.of(context);

    final ownedIds = {for (final t in [...state.ongoing, ...state.past]) t.id};
    final assignedExtras =
        state.assigned.where((t) => !ownedIds.contains(t.id)).toList();

    final openTickets = [
      ...state.ongoing,
      ...assignedExtras.where((t) => kHelpdeskOngoingStatuses.contains(t.status)),
    ];
    final pastTickets = [
      ...state.past,
      ...assignedExtras.where((t) => !kHelpdeskOngoingStatuses.contains(t.status)),
    ];

    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Scaffold(
        body: Column(
          children: [
            // Top row: title + refresh
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'מוקד איחוד - הקריאות שלי',
                    style: theme.textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.bold),
                  ),
                  Row(children: [
                    if (state.isLoading)
                      const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2)),
                    IconButton(
                      icon: const Icon(Icons.refresh),
                      tooltip: 'רענן',
                      onPressed: () =>
                          ref.read(helpdeskProvider.notifier).loadTickets(force: true),
                    ),
                  ]),
                ],
              ),
            ),

            // Tab bar: פתוחות | טופלו
            TabBar(
              controller: _tabController,
              tabs: [
                Tab(text: 'פתוחות (${openTickets.length})'),
                Tab(text: 'טופלו (${pastTickets.length})'),
              ],
            ),

            if (state.error != null)
              MaterialBanner(
                content: Text(state.error!),
                backgroundColor: theme.colorScheme.errorContainer,
                actions: [
                  TextButton(
                    onPressed: () =>
                        ref.read(helpdeskProvider.notifier).loadTickets(force: true),
                    child: const Text('נסה שוב'),
                  ),
                ],
              ),

            Expanded(
              child: TabBarView(
                controller: _tabController,
                children: [
                  _TicketList(tickets: openTickets, emptyMessage: 'אין פניות פתוחות'),
                  _TicketList(tickets: pastTickets, emptyMessage: 'אין פניות שטופלו'),
                ],
              ),
            ),
          ],
        ),
        floatingActionButton: FloatingActionButton.extended(
          onPressed: () => _showDepartmentSelectionDialog(context),
          icon: const Icon(Icons.add),
          label: const Text('פנייה חדשה'),
        ),
      ),
    );
  }

  void _showDepartmentSelectionDialog(BuildContext ctx) {
    showModalBottomSheet(
      context: ctx,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (_) => SafeArea(
        child: Directionality(
          textDirection: ui.TextDirection.rtl,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('בחר מחלקה',
                    style: Theme.of(ctx)
                        .textTheme
                        .titleLarge
                        ?.copyWith(fontWeight: FontWeight.bold),
                    textAlign: TextAlign.center),
                const SizedBox(height: 8),
                Text('לאיזו מחלקה שייכת הבקשה?',
                    style: Theme.of(ctx).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(ctx)
                              .colorScheme
                              .onSurface
                              .withAlpha((255 * 0.6).round()),
                        ),
                    textAlign: TextAlign.center),
                const SizedBox(height: 24),
                OutlinedButton.icon(
                  onPressed: () {
                    Navigator.of(ctx).pop();
                    _showTicketFormDialog(ctx, HelpdeskDepartment.it);
                  },
                  icon: const Icon(Icons.computer),
                  label: const Text('מערכות מידע'),
                  style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16)),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () {
                    Navigator.of(ctx).pop();
                    _showTicketFormDialog(ctx, HelpdeskDepartment.maintenance);
                  },
                  icon: const Icon(Icons.build),
                  label: const Text('אחזקה'),
                  style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 16)),
                ),
                const SizedBox(height: 16),
                TextButton.icon(
                  onPressed: () => Navigator.of(ctx).pop(),
                  icon: const Icon(Icons.arrow_back),
                  label: const Text('חזרה'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _showTicketFormDialog(BuildContext ctx, HelpdeskDepartment dept) {
    final subjectCtrl = TextEditingController();
    final descCtrl = TextEditingController();
    final locationCtrl = TextEditingController();
    // Pre-fill with the phone number that was used to log in.
    // currentUserPhoneProvider holds the phone stored at login time.
    // currentUserProvider is the username, which for this app IS the phone
    // number — used as a reliable fallback for existing sessions that
    // pre-date phone persistence.
    final userPhone =
        ref.read(currentUserPhoneProvider) ?? ref.read(currentUserProvider) ?? '';
    final phoneCtrl = TextEditingController(text: userPhone);
    String priority = 'normal';
    List<String> locations = [];
    bool loadingLoc = true;
    bool locFetchStarted = false;

    // Attachment state
    xfile.XFile? attachedFile;
    Uint8List? attachedFileBytes;
    bool isUploadingAttachment = false;

    Future<void> pickAttachment(StateSetter setSt) async {
      // Show source picker for images; on web only gallery is available.
      final picker = img_picker.ImagePicker();

      if (kIsWeb) {
        // Web: pick from gallery only.
        final picked = await picker.pickImage(
          source: img_picker.ImageSource.gallery,
          imageQuality: 85,
          maxWidth: 1920,
          maxHeight: 1920,
        );
        if (picked != null) {
          final bytes = await picked.readAsBytes();
          final mimeType =
              xfile.XFileUtils.mimeTypeFromExtension(picked.name.split('.').last);
          setSt(() {
            attachedFile =
                xfile.XFile.fromBytes(name: picked.name, bytes: bytes, mimeType: mimeType);
            attachedFileBytes = bytes;
          });
        }
        return;
      }

      // Native: ask camera or gallery.
      final source = await showModalBottomSheet<img_picker.ImageSource>(
        context: ctx,
        shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
        builder: (_) => SafeArea(
          child: Directionality(
            textDirection: ui.TextDirection.rtl,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ListTile(
                    leading: const Icon(Icons.camera_alt),
                    title: const Text('צלם תמונה'),
                    onTap: () =>
                        Navigator.of(ctx).pop(img_picker.ImageSource.camera),
                  ),
                  ListTile(
                    leading: const Icon(Icons.photo_library),
                    title: const Text('בחר מהגלריה'),
                    onTap: () =>
                        Navigator.of(ctx).pop(img_picker.ImageSource.gallery),
                  ),
                  ListTile(
                    leading: const Icon(Icons.cancel_outlined),
                    title: const Text('ביטול'),
                    onTap: () => Navigator.of(ctx).pop(),
                  ),
                ],
              ),
            ),
          ),
        ),
      );

      if (source == null) return;

      final picked = await picker.pickImage(
        source: source,
        imageQuality: 85,
        maxWidth: 1920,
        maxHeight: 1920,
      );
      if (picked != null) {
        final bytes = await picked.readAsBytes();
        final mimeType =
            xfile.XFileUtils.mimeTypeFromExtension(picked.name.split('.').last);
        setSt(() {
          attachedFile =
              xfile.XFile.fromBytes(name: picked.name, bytes: bytes, mimeType: mimeType);
          attachedFileBytes = bytes;
        });
      }
    }

    showDialog(
      context: ctx,
      builder: (_) => StatefulBuilder(
        builder: (context, setSt) {
          if (!locFetchStarted) {
            locFetchStarted = true;
            ref.read(helpdeskProvider.notifier).loadLocations().then((locs) {
              setSt(() {
                locations = locs;
                loadingLoc = false;
              });
            }).catchError((_) {
              setSt(() => loadingLoc = false);
            });
          }
          return Directionality(
          textDirection: ui.TextDirection.rtl,
          child: AlertDialog(
            title: Text('קריאה חדשה - ${dept.label}'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TextField(
                    controller: subjectCtrl,
                    textDirection: ui.TextDirection.rtl,
                    decoration: const InputDecoration(
                        labelText: 'כותרת הקריאה *',
                        border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: descCtrl,
                    textDirection: ui.TextDirection.rtl,
                    maxLines: 4,
                    decoration: const InputDecoration(
                        labelText: 'תיאור הבעיה',
                        border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 16),
                  Autocomplete<String>(
                    key: ValueKey(loadingLoc),
                    optionsBuilder: (tv) => tv.text.isEmpty
                        ? locations
                        : locations.where((l) =>
                            l.toLowerCase().contains(tv.text.toLowerCase())),
                    onSelected: (v) => locationCtrl.text = v,
                    fieldViewBuilder: (context, ctrl, fn, oec) => TextField(
                      controller: ctrl,
                      focusNode: fn,
                      onEditingComplete: oec,
                      textDirection: ui.TextDirection.rtl,
                      decoration: InputDecoration(
                        labelText: 'מיקום *',
                        border: const OutlineInputBorder(),
                        suffixIcon: loadingLoc
                            ? const Padding(
                                padding: EdgeInsets.all(8),
                                child: SizedBox(
                                    width: 20,
                                    height: 20,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2)),
                              )
                            : null,
                      ),
                      onChanged: (v) => locationCtrl.text = v,
                    ),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: phoneCtrl,
                    textDirection: ui.TextDirection.ltr,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(
                        labelText: 'טלפון ליצירת קשר',
                        border: OutlineInputBorder(),
                        hintText: '05X-XXXXXXX'),
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    value: priority,
                    decoration: const InputDecoration(
                        labelText: 'דחיפות', border: OutlineInputBorder()),
                    items: const [
                      DropdownMenuItem(value: 'low', child: Text('נמוכה')),
                      DropdownMenuItem(value: 'normal', child: Text('רגילה')),
                      DropdownMenuItem(value: 'high', child: Text('גבוהה')),
                      DropdownMenuItem(value: 'urgent', child: Text('דחופה')),
                    ],
                    onChanged: (v) => setSt(() => priority = v ?? 'normal'),
                  ),
                  const SizedBox(height: 16),
                  // Attachment picker
                  if (attachedFileBytes != null) ...[
                    Stack(
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: Image.memory(
                            attachedFileBytes!,
                            height: 120,
                            width: double.infinity,
                            fit: BoxFit.cover,
                          ),
                        ),
                        Positioned(
                          top: 4,
                          left: 4,
                          child: GestureDetector(
                            onTap: () => setSt(() {
                              attachedFile = null;
                              attachedFileBytes = null;
                            }),
                            child: Container(
                              decoration: const BoxDecoration(
                                color: Colors.black54,
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(Icons.close,
                                  color: Colors.white, size: 18),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                  ] else ...[
                    OutlinedButton.icon(
                      onPressed: isUploadingAttachment
                          ? null
                          : () => pickAttachment(setSt),
                      icon: const Icon(Icons.attach_file),
                      label: const Text('צרף תמונה / קובץ'),
                      style: OutlinedButton.styleFrom(
                          minimumSize:
                              const Size(double.infinity, 44)),
                    ),
                  ],
                  if (isUploadingAttachment)
                    const Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: Row(children: [
                        SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                                strokeWidth: 2)),
                        SizedBox(width: 8),
                        Text('מעלה קובץ...', style: TextStyle(fontSize: 12)),
                      ]),
                    ),
                ],
              ),
            ),
            actions: [
              TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('ביטול')),
              ElevatedButton(
                onPressed: isUploadingAttachment
                    ? null
                    : () async {
                        if (subjectCtrl.text.trim().isEmpty) {
                          showTopToast(context, 'יש להזין כותרת');
                          return;
                        }
                        if (locationCtrl.text.trim().isEmpty) {
                          showTopToast(context, 'יש להזין מיקום');
                          return;
                        }

                        // Upload attachment if one was selected.
                        String? attachmentUrl;
                        final pendingFile = attachedFile;
                        if (pendingFile != null) {
                          setSt(() => isUploadingAttachment = true);
                          try {
                            final api = ref.read(chatApiServiceProvider);
                            attachmentUrl =
                                await api.uploadHelpdeskAttachment(pendingFile);
                          } catch (e) {
                            setSt(() => isUploadingAttachment = false);
                            if (ctx.mounted) {
                              showTopToast(
                                ctx,
                                'שגיאה בהעלאת הקובץ: ${e.toString()}',
                                backgroundColor:
                                    Theme.of(ctx).colorScheme.error,
                              );
                            }
                            return;
                          }
                          setSt(() => isUploadingAttachment = false);
                        }

                        Navigator.of(context).pop();
                        try {
                          await ref
                              .read(helpdeskProvider.notifier)
                              .createTicket(
                                subject: subjectCtrl.text.trim(),
                                description: descCtrl.text.trim(),
                                department: dept,
                                priority: priority,
                                location: locationCtrl.text.trim().isEmpty
                                    ? null
                                    : locationCtrl.text.trim(),
                                phone: phoneCtrl.text.trim().isEmpty
                                    ? null
                                    : phoneCtrl.text.trim(),
                                attachmentUrl: attachmentUrl,
                              );
                          if (ctx.mounted) {
                            showTopToast(ctx, 'הפנייה נוצרה בהצלחה');
                          }
                        } catch (e) {
                          if (ctx.mounted) {
                            showTopToast(
                              ctx,
                              'שגיאה: ${e.toString()}',
                              backgroundColor:
                                  Theme.of(ctx).colorScheme.error,
                            );
                          }
                        }
                      },
                child: const Text('שלח קריאה'),
              ),
            ],
          ),
        );
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Ticket Manager Screen ('מנהל קריאות') — admins/editors only
// ---------------------------------------------------------------------------

/// Standalone screen wrapping [_ManagementTab]. Placed in the bottom-nav as
/// a separate destination so regular users only see their own tickets in the
/// 'מוקד איחוד' tab while admins/editors access ticket management here.
class TicketManagerScreen extends ConsumerWidget {
  const TicketManagerScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(helpdeskProvider);
    final theme = Theme.of(context);

    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Scaffold(
        body: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'מנהל קריאות',
                    style: theme.textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.bold),
                  ),
                  Row(children: [
                    if (state.isLoading)
                      const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2)),
                    IconButton(
                      icon: const Icon(Icons.refresh),
                      tooltip: 'רענן',
                      onPressed: () =>
                          ref.read(helpdeskProvider.notifier).loadTickets(force: true),
                    ),
                  ]),
                ],
              ),
            ),
            Expanded(
              child: _ManagementTab(
                myRole: state.myRole,
                editorTickets: state.editorTickets,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Management Tab (ניהול) - for editors / admins
// ---------------------------------------------------------------------------

class _ManagementTab extends ConsumerStatefulWidget {
  final HelpdeskMyRole? myRole;
  final List<HelpdeskTicket> editorTickets;

  const _ManagementTab({required this.myRole, required this.editorTickets});

  @override
  ConsumerState<_ManagementTab> createState() => _ManagementTabState();
}

class _ManagementTabState extends ConsumerState<_ManagementTab>
    with SingleTickerProviderStateMixin {
  late TabController _subTabController;

  @override
  void initState() {
    super.initState();
    _subTabController = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _subTabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final role = widget.myRole;

    if (role == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.manage_accounts_outlined,
                size: 80, color: theme.colorScheme.primary.withAlpha(100)),
            const SizedBox(height: 16),
            Text('ניהול קריאות',
                style: theme.textTheme.titleLarge?.copyWith(
                    color: theme.colorScheme.onSurface.withAlpha(178))),
            const SizedBox(height: 8),
            Text('תפריט זה זמין למנהלים בלבד',
                style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurface.withAlpha(128))),
          ],
        ),
      );
    }

    // For relatedUser: only show tickets where the current user is creator or handler
    final currentUser =
        ref.read(helpdeskProvider.notifier).currentUser;
    final visibleTickets = role.role == HelpdeskRole.relatedUser
        ? widget.editorTickets
            .where((t) =>
                t.creatorUsername == currentUser ||
                t.handlerUsername == currentUser)
            .toList()
        : widget.editorTickets;

    final newTickets =
        visibleTickets.where((t) => t.status == 'open').toList();
    final inProgressTickets =
        visibleTickets.where((t) => t.status == 'in_progress').toList();
    final closedTickets = visibleTickets
        .where((t) => !kHelpdeskOngoingStatuses.contains(t.status))
        .toList();

    final String roleLabel;
    switch (role.role) {
      case HelpdeskRole.admin:
        roleLabel = 'Admin';
        break;
      case HelpdeskRole.relatedUser:
        roleLabel = 'RelatedUser';
        break;
      default:
        roleLabel = 'Editor';
    }

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(children: [
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: theme.colorScheme.primary,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Text(
                  roleLabel,
                  style: const TextStyle(
                      color: Colors.white, fontWeight: FontWeight.bold)),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text('ניהול קריאות - ${role.department}',
                  style: theme.textTheme.titleSmall
                      ?.copyWith(fontWeight: FontWeight.bold)),
            ),
          ]),
        ),
        TabBar(
          controller: _subTabController,
          tabs: [
            Tab(text: 'חדש (${newTickets.length})'),
            Tab(text: 'בתהליך (${inProgressTickets.length})'),
            Tab(text: 'סגור (${closedTickets.length})'),
          ],
          labelColor: theme.colorScheme.primary,
          indicatorColor: theme.colorScheme.primary,
        ),
        Expanded(
          child: TabBarView(
            controller: _subTabController,
            children: [
              _TicketList(
                  tickets: newTickets,
                  emptyMessage: 'אין קריאות חדשות',
                  isManagerView: true),
              _TicketList(
                  tickets: inProgressTickets,
                  emptyMessage: 'אין קריאות בתהליך',
                  isManagerView: true),
              _TicketList(
                  tickets: closedTickets,
                  emptyMessage: 'אין קריאות סגורות',
                  isManagerView: true),
            ],
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Ticket List
// ---------------------------------------------------------------------------

class _TicketList extends ConsumerWidget {
  final List<HelpdeskTicket> tickets;
  final String emptyMessage;
  final bool isManagerView;

  const _TicketList(
      {required this.tickets,
      required this.emptyMessage,
      this.isManagerView = false});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final isLoading = ref.watch(helpdeskProvider).isLoading;

    if (isLoading && tickets.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (tickets.isEmpty) {
      return RefreshIndicator(
        onRefresh: () async =>
            ref.read(helpdeskProvider.notifier).loadTickets(force: true),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: MediaQuery.of(context).size.height * 0.55,
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.support_agent_outlined,
                      size: 80,
                      color: theme.colorScheme.primary.withAlpha(100)),
                  const SizedBox(height: 16),
                  Text(emptyMessage,
                      textAlign: TextAlign.center,
                      style: theme.textTheme.titleMedium?.copyWith(
                          color: theme.colorScheme.onSurface.withAlpha(178))),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: () =>
                        ref.read(helpdeskProvider.notifier).loadTickets(force: true),
                    icon: const Icon(Icons.refresh),
                    label: const Text('רענן'),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () async =>
          ref.read(helpdeskProvider.notifier).loadTickets(force: true),
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        itemCount: tickets.length,
        itemBuilder: (context, i) =>
            _TicketCard(ticket: tickets[i], isManagerView: isManagerView),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Ticket Card - matches Angular layout
// ---------------------------------------------------------------------------

class _TicketCard extends ConsumerWidget {
  final HelpdeskTicket ticket;
  final bool isManagerView;

  const _TicketCard({required this.ticket, this.isManagerView = false});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final timeStr = DateFormat('HH:mm').format(ticket.createdAt);

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => _openDetail(context, ref),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Status badge (right-aligned in RTL)
              Align(
                alignment: Alignment.topLeft,
                child: _StatusChip(status: ticket.status),
              ),
              const SizedBox(height: 6),
              _MetaRow(label: 'כותרת', value: ticket.subject, bold: true),
              _MetaRow(label: 'מחלקה', value: ticket.department),
              if (ticket.location != null && ticket.location!.isNotEmpty)
                _MetaRow(label: 'מיקום', value: ticket.location!),
              _MetaRow(label: 'תאריך', value: timeStr),
            ],
          ),
        ),
      ),
    );
  }

  void _openDetail(BuildContext context, WidgetRef ref) {
    final state = ref.read(helpdeskProvider);
    final currentUser = ref.read(helpdeskProvider.notifier).currentUser;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (_) => _TicketDetailSheet(
        ticket: ticket,
        myRole: state.myRole,
        handlers: state.handlers,
        currentUser: currentUser,
        isManagerView: isManagerView,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Ticket card sub-widgets
// ---------------------------------------------------------------------------

class _StatusChip extends StatelessWidget {
  final String status;

  const _StatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(status);
    final label = _statusLabel(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(
        color: color.withAlpha(30),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withAlpha(100)),
      ),
      child: Text(label,
          style: TextStyle(
              color: color, fontSize: 12, fontWeight: FontWeight.bold)),
    );
  }
}

class _MetaRow extends StatelessWidget {
  final String label;
  final String value;
  final bool bold;

  const _MetaRow({required this.label, required this.value, this.bold = false});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final labelStyle = theme.textTheme.bodySmall
        ?.copyWith(color: theme.colorScheme.onSurface.withAlpha(128));
    final valueStyle = bold
        ? theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.bold)
        : theme.textTheme.bodyMedium;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(
              child: Text(value,
                  style: valueStyle, overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 8),
          SizedBox(
              width: 50,
              child:
                  Text(label, style: labelStyle, textAlign: TextAlign.end)),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Ticket Detail Bottom Sheet
// ---------------------------------------------------------------------------

class _TicketDetailSheet extends ConsumerStatefulWidget {
  final HelpdeskTicket ticket;
  final HelpdeskMyRole? myRole;
  final List<HelpdeskManagedUser> handlers;
  final String currentUser;
  final bool isManagerView;

  const _TicketDetailSheet({
    required this.ticket,
    required this.myRole,
    required this.handlers,
    required this.currentUser,
    this.isManagerView = false,
  });

  @override
  ConsumerState<_TicketDetailSheet> createState() => _TicketDetailSheetState();
}

class _TicketDetailSheetState extends ConsumerState<_TicketDetailSheet> {
  List<HelpdeskStatusHistoryEntry>? _history;
  List<HelpdeskHandlerHistoryEntry>? _handlerHistory;
  List<HelpdeskNote>? _notes;
  bool _loadingHistory = true;
  bool _loadingHandlerHistory = true;
  bool _loadingNotes = true;
  String? _historyError;

  String? _selectedHandler;
  String _selectedStatus = '';
  bool _savingHandler = false;
  bool _savingStatus = false;
  String? _handlerError;
  String? _statusError;

  final _noteCtrl = TextEditingController();
  bool _submittingNote = false;
  String? _noteError;

  HelpdeskTicket get _ticket => widget.ticket;
  String get _currentUser => widget.currentUser;

  bool get _canManageHandler {
    if (!widget.isManagerView) return false;
    if (_ticket.status == 'closed') return false;
    if (widget.myRole == null) return false;
    // relatedUser: allowed only for tickets they created or are handling
    if (widget.myRole!.role == HelpdeskRole.relatedUser) {
      return _ticket.creatorUsername == _currentUser ||
          _ticket.handlerUsername == _currentUser;
    }
    // editor / admin: allowed for any ticket in their department
    return widget.myRole!.department == _ticket.department;
  }

  bool get _canChangeStatus {
    if (!widget.isManagerView) return false;
    if (_ticket.status == 'closed') return false;
    if (_ticket.creatorUsername == _currentUser) return true;
    if (_ticket.handlerUsername == _currentUser) return true;
    if (widget.myRole != null &&
        widget.myRole!.department == _ticket.department) return true;
    return false;
  }

  @override
  void initState() {
    super.initState();
    _selectedHandler = _ticket.handlerUsername;
    _selectedStatus = _ticket.status;
    _loadData();
  }

  @override
  void dispose() {
    _noteCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    final api = ref.read(chatApiServiceProvider);
    final ticketId = int.tryParse(_ticket.id) ?? 0;
    await Future.wait([_loadHistory(api, ticketId), _loadHandlerHistory(api, ticketId), _loadNotes(api, ticketId)]);
  }

  Future<void> _loadHistory(ChatApiService api, int ticketId) async {
    try {
      final h = await api.getHelpdeskTicketHistory(ticketId, _currentUser);
      if (mounted) setState(() { _history = h; _loadingHistory = false; _historyError = null; });
    } catch (e) {
      if (mounted) setState(() { _history = []; _loadingHistory = false; _historyError = e.toString(); });
    }
  }

  Future<void> _loadHandlerHistory(ChatApiService api, int ticketId) async {
    try {
      final h = await api.getHelpdeskTicketHandlerHistory(ticketId, _currentUser);
      if (mounted) setState(() { _handlerHistory = h; _loadingHandlerHistory = false; });
    } catch (_) {
      if (mounted) setState(() { _handlerHistory = []; _loadingHandlerHistory = false; });
    }
  }

  Future<void> _loadNotes(ChatApiService api, int ticketId) async {
    try {
      final n = await api.getHelpdeskTicketNotes(ticketId, _currentUser);
      if (mounted) setState(() { _notes = n; _loadingNotes = false; });
    } catch (_) {
      if (mounted) setState(() { _notes = []; _loadingNotes = false; });
    }
  }

  Future<void> _saveHandler() async {
    setState(() { _savingHandler = true; _handlerError = null; });
    try {
      await ref
          .read(helpdeskProvider.notifier)
          .assignHandler(int.parse(_ticket.id), _selectedHandler);
      if (mounted) {
        showTopToast(context, 'המטפל עודכן בהצלחה');
        setState(() { _loadingHandlerHistory = true; });
        final api = ref.read(chatApiServiceProvider);
        await _loadHandlerHistory(api, int.parse(_ticket.id));
      }
    } catch (e) {
      if (mounted) setState(() => _handlerError = e.toString());
    } finally {
      if (mounted) setState(() => _savingHandler = false);
    }
  }

  Future<void> _saveStatus() async {
    setState(() { _savingStatus = true; _statusError = null; });
    try {
      await ref
          .read(helpdeskProvider.notifier)
          .updateTicketStatus(int.parse(_ticket.id), _selectedStatus);
      if (mounted) {
        showTopToast(context, 'הסטטוס עודכן בהצלחה');
        setState(() { _loadingHistory = true; _historyError = null; });
        final api = ref.read(chatApiServiceProvider);
        await _loadHistory(api, int.parse(_ticket.id));
      }
    } catch (e) {
      if (mounted) setState(() => _statusError = e.toString());
    } finally {
      if (mounted) setState(() => _savingStatus = false);
    }
  }

  Future<void> _submitNote() async {
    final text = _noteCtrl.text.trim();
    if (text.length < 2) return;
    setState(() { _submittingNote = true; _noteError = null; });
    try {
      final api = ref.read(chatApiServiceProvider);
      final note = await api.addHelpdeskTicketNote(
          int.parse(_ticket.id), text, _currentUser);
      _noteCtrl.clear();
      if (mounted) setState(() => _notes = [...?_notes, note]);
    } catch (e) {
      if (mounted) setState(() => _noteError = e.toString());
    } finally {
      if (mounted) setState(() => _submittingNote = false);
    }
  }

  String _resolveDisplay(String? username) {
    if (username == null || username.isEmpty) return '—';
    final contacts = ref.read(chatStoreProvider).contacts;
    return contacts[username]?.displayName ?? username;
  }

  /// Returns the phone number stored in the contacts store for [username],
  /// or null if unavailable. Mirrors Angular `resolveContact().phone`.
  String? _resolveContactPhone(String? username) {
    if (username == null || username.isEmpty) return null;
    final contacts = ref.read(chatStoreProvider).contacts;
    final phone = contacts[username]?.phone;
    return (phone != null && phone.isNotEmpty) ? phone : null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final durationLabel =
        _history != null ? _totalDurationLabel(_history!) : '';

    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.92,
        minChildSize: 0.5,
        maxChildSize: 0.97,
        builder: (context, scrollController) => Column(
          children: [
            Container(
              width: 40,
              height: 4,
              margin: const EdgeInsets.only(top: 10, bottom: 4),
              decoration: BoxDecoration(
                  color: Colors.grey.shade400,
                  borderRadius: BorderRadius.circular(2)),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(children: [
                Text('#${_ticket.id}',
                    style: theme.textTheme.titleSmall?.copyWith(
                        color: theme.colorScheme.onSurface.withAlpha(128))),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(_ticket.subject,
                      style: theme.textTheme.titleLarge
                          ?.copyWith(fontWeight: FontWeight.bold),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                ),
                const SizedBox(width: 8),
                _StatusChip(status: _selectedStatus),
              ]),
            ),
            const Divider(height: 1),
            Expanded(
              child: ListView(
                controller: scrollController,
                padding: const EdgeInsets.all(16),
                children: [
                  _DetailRow(icon: Icons.apartment, label: 'מחלקה', value: _ticket.department),
                  if (_ticket.location != null && _ticket.location!.isNotEmpty)
                    _DetailRow(
                        icon: Icons.location_on,
                        label: 'מיקום',
                        value: _ticket.location!),
                  if (_ticket.description.isNotEmpty)
                    _DetailRow(
                        icon: Icons.description,
                        label: 'תיאור',
                        value: _ticket.description),
                  _DetailRow(
                      icon: Icons.schedule,
                      label: 'נפתחה',
                      value: DateFormat('HH:mm, d.M.yyyy').format(_ticket.createdAt)),
                  _DetailRow(
                      icon: Icons.person,
                      label: 'נפתח על-ידי',
                      value: _resolveDisplay(_ticket.creatorUsername)),
                  if (_resolveContactPhone(_ticket.creatorUsername) != null)
                    _DetailRow(
                        icon: Icons.phone,
                        label: 'טלפון (איש קשר)',
                        value: _resolveContactPhone(_ticket.creatorUsername)!),
                  if (_ticket.phone != null && _ticket.phone!.isNotEmpty)
                    _DetailRow(
                        icon: Icons.phone,
                        label: 'טלפון',
                        value: _ticket.phone!),
                  if (_ticket.attachmentUrl != null &&
                      _ticket.attachmentUrl!.isNotEmpty)
                    _AttachmentRow(url: _ticket.attachmentUrl!),
                  _DetailRow(
                      icon: Icons.support_agent,
                      label: 'מטפל',
                      value: _resolveDisplay(_ticket.handlerUsername)),

                  const SizedBox(height: 16),
                  const Divider(),
                  const SizedBox(height: 8),

                  // Status history header
                  Row(children: [
                    const Icon(Icons.history, size: 20),
                    const SizedBox(width: 6),
                    Text('היסטוריית סטטוס',
                        style: theme.textTheme.titleSmall
                            ?.copyWith(fontWeight: FontWeight.bold)),
                    const Spacer(),
                    if (durationLabel.isNotEmpty)
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                            color: Colors.blue.shade50,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: Colors.blue.shade200)),
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          Icon(Icons.timer, size: 14, color: Colors.blue.shade700),
                          const SizedBox(width: 4),
                          Text(durationLabel,
                              style: TextStyle(
                                  color: Colors.blue.shade700, fontSize: 12)),
                        ]),
                      ),
                  ]),
                  const SizedBox(height: 8),
                  if (_loadingHistory)
                    const Center(child: CircularProgressIndicator())
                  else if (_historyError != null)
                    Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('שגיאה בטעינת ההיסטוריה',
                          style: theme.textTheme.bodySmall?.copyWith(color: Colors.red.shade700)),
                      const SizedBox(height: 4),
                      TextButton.icon(
                        onPressed: () async {
                          setState(() { _loadingHistory = true; _historyError = null; });
                          final api = ref.read(chatApiServiceProvider);
                          final ticketId = int.tryParse(_ticket.id) ?? 0;
                          await _loadHistory(api, ticketId);
                        },
                        icon: const Icon(Icons.refresh, size: 16),
                        label: const Text('נסה שוב'),
                        style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 30)),
                      ),
                    ])
                  else if (_history == null || _history!.isEmpty)
                    Text('אין היסטוריית שינויי סטטוס.',
                        style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurface.withAlpha(128)))
                  else
                    ..._history!.reversed.map((h) => _HistoryEntry(
                          entry: h,
                          displayName: _resolveDisplay(h.changedBy),
                        )),

                  // Handler assignment history (visible to all users)
                  const SizedBox(height: 16),
                  const Divider(),
                  const SizedBox(height: 8),
                  Row(children: [
                    const Icon(Icons.person_pin, size: 20),
                    const SizedBox(width: 6),
                    Text('היסטוריית מטפלים',
                        style: theme.textTheme.titleSmall
                            ?.copyWith(fontWeight: FontWeight.bold)),
                  ]),
                  const SizedBox(height: 8),
                  if (_loadingHandlerHistory)
                    const Center(child: CircularProgressIndicator())
                  else if (_handlerHistory == null || _handlerHistory!.isEmpty)
                    Text('אין היסטוריית שיוך מטפלים.',
                        style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurface.withAlpha(128)))
                  else
                    ..._handlerHistory!.reversed.map((h) => _HandlerHistoryEntry(
                          entry: h,
                          resolveDisplay: _resolveDisplay,
                        )),

                  // Handler assignment (editor only)
                  if (_canManageHandler) ...[
                    const SizedBox(height: 16),
                    const Divider(),
                    const SizedBox(height: 8),
                    Row(children: [
                      const Icon(Icons.manage_accounts, size: 20),
                      const SizedBox(width: 6),
                      Text('שיוך מטפל',
                          style: theme.textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.bold)),
                    ]),
                    const SizedBox(height: 8),
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Expanded(
                        child: DropdownButtonFormField<String?>(
                          value: _selectedHandler,
                          decoration: const InputDecoration(
                              labelText: 'בחר מטפל',
                              border: OutlineInputBorder()),
                          items: [
                            const DropdownMenuItem<String?>(
                                value: null, child: Text('— ללא מטפל —')),
                            ...widget.handlers.map((h) =>
                                DropdownMenuItem<String?>(
                                    value: h.username,
                                    child: Text(_resolveDisplay(h.username)))),
                          ],
                          onChanged: (v) =>
                              setState(() => _selectedHandler = v),
                        ),
                      ),
                      const SizedBox(width: 8),
                      ElevatedButton.icon(
                        onPressed: _savingHandler ? null : _saveHandler,
                        icon: _savingHandler
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2))
                            : const Icon(Icons.save),
                        label: const Text('שמור'),
                      ),
                    ]),
                    if (_handlerError != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(_handlerError!,
                            style: TextStyle(
                                color: theme.colorScheme.error, fontSize: 12)),
                      ),
                  ],

                  // Status change
                  if (_canChangeStatus) ...[
                    const SizedBox(height: 16),
                    const Divider(),
                    const SizedBox(height: 8),
                    Row(children: [
                      const Icon(Icons.update, size: 20),
                      const SizedBox(width: 6),
                      Text('עדכון סטטוס',
                          style: theme.textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.bold)),
                    ]),
                    const SizedBox(height: 8),
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Expanded(
                        child: DropdownButtonFormField<String>(
                          value: _selectedStatus,
                          decoration: const InputDecoration(
                              labelText: 'סטטוס',
                              border: OutlineInputBorder()),
                          items: ['open', 'in_progress', 'resolved', 'closed']
                              .map((s) => DropdownMenuItem(
                                  value: s, child: Text(_statusLabel(s))))
                              .toList(),
                          onChanged: (v) => setState(
                              () => _selectedStatus = v ?? _selectedStatus),
                        ),
                      ),
                      const SizedBox(width: 8),
                      ElevatedButton.icon(
                        onPressed: _savingStatus ? null : _saveStatus,
                        icon: _savingStatus
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2))
                            : const Icon(Icons.save),
                        label: const Text('שמור'),
                      ),
                    ]),
                    if (_statusError != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(_statusError!,
                            style: TextStyle(
                                color: theme.colorScheme.error, fontSize: 12)),
                      ),
                  ],

                  // Notes section
                  const SizedBox(height: 16),
                  const Divider(),
                  const SizedBox(height: 8),
                  Row(children: [
                    const Icon(Icons.chat_bubble_outline, size: 20),
                    const SizedBox(width: 6),
                    Text('הערות',
                        style: theme.textTheme.titleSmall
                            ?.copyWith(fontWeight: FontWeight.bold)),
                  ]),
                  const SizedBox(height: 8),
                  if (_loadingNotes)
                    const Center(child: CircularProgressIndicator())
                  else if (_notes == null || _notes!.isEmpty)
                    Text('אין הערות עדיין.',
                        style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurface.withAlpha(128)))
                  else
                    ..._notes!.map((n) => _NoteItem(
                        note: n,
                        isOwn: n.authorUsername == _currentUser,
                        resolveDisplay: _resolveDisplay)),

                  const SizedBox(height: 12),
                  TextField(
                    controller: _noteCtrl,
                    textDirection: ui.TextDirection.rtl,
                    maxLines: 3,
                    decoration: const InputDecoration(
                        labelText: 'הערה חדשה',
                        hintText: 'כתוב הערה...',
                        border: OutlineInputBorder()),
                  ),
                  if (_noteError != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(_noteError!,
                          style: TextStyle(
                              color: theme.colorScheme.error, fontSize: 12)),
                    ),
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton.icon(
                      onPressed: _submittingNote ? null : _submitNote,
                      icon: _submittingNote
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.send),
                      label: const Text('שלח הערה'),
                    ),
                  ),

                  const SizedBox(height: 16),
                  OutlinedButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('סגור')),
                  const SizedBox(height: 24),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Detail sub-widgets
// ---------------------------------------------------------------------------

class _DetailRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _DetailRow(
      {required this.icon, required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: theme.colorScheme.primary),
          const SizedBox(width: 10),
          SizedBox(
            width: 90,
            child: Text(label,
                style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurface.withAlpha(150))),
          ),
          Expanded(child: Text(value, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}

class _HistoryEntry extends StatelessWidget {
  final HelpdeskStatusHistoryEntry entry;
  final String displayName;

  const _HistoryEntry({required this.entry, required this.displayName});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final timeStr =
        DateFormat('H:mm, d.M.yyyy').format(entry.createdAt);

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(children: [
            Container(
              width: 10,
              height: 10,
              margin: const EdgeInsets.only(top: 4),
              decoration: BoxDecoration(
                  color: theme.colorScheme.primary,
                  shape: BoxShape.circle),
            ),
          ]),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(displayName.isNotEmpty ? displayName : entry.changedBy,
                        style: theme.textTheme.bodySmall
                            ?.copyWith(fontWeight: FontWeight.bold)),
                    Text(timeStr,
                        style: theme.textTheme.bodySmall?.copyWith(
                            color:
                                theme.colorScheme.onSurface.withAlpha(128))),
                  ],
                ),
                const SizedBox(height: 4),
                Row(children: [
                  if (entry.oldStatus != null && entry.oldStatus!.isNotEmpty) ...[
                    _MiniStatusChip(status: entry.oldStatus!),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 4),
                      child: Icon(Icons.arrow_forward, size: 14),
                    ),
                    _MiniStatusChip(status: entry.newStatus),
                  ] else ...[
                    const Padding(
                      padding: EdgeInsets.only(left: 4),
                      child: Icon(Icons.add_circle_outline, size: 14),
                    ),
                    const SizedBox(width: 4),
                    _MiniStatusChip(status: entry.newStatus),
                  ],
                ]),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _MiniStatusChip extends StatelessWidget {
  final String status;

  const _MiniStatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withAlpha(25),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withAlpha(80)),
      ),
      child: Text(_statusLabel(status),
          style: TextStyle(
              color: color, fontSize: 11, fontWeight: FontWeight.bold)),
    );
  }
}

class _HandlerHistoryEntry extends StatelessWidget {
  final HelpdeskHandlerHistoryEntry entry;
  final String Function(String?) resolveDisplay;

  const _HandlerHistoryEntry({required this.entry, required this.resolveDisplay});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final timeStr = DateFormat('H:mm, d.M.yyyy').format(entry.createdAt);
    final oldName = entry.oldHandler != null ? resolveDisplay(entry.oldHandler) : '—';
    final newName = entry.newHandler != null ? resolveDisplay(entry.newHandler) : '—';

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(children: [
            Container(
              width: 10,
              height: 10,
              margin: const EdgeInsets.only(top: 4),
              decoration: BoxDecoration(
                  color: theme.colorScheme.secondary,
                  shape: BoxShape.circle),
            ),
          ]),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(resolveDisplay(entry.changedBy),
                        style: theme.textTheme.bodySmall
                            ?.copyWith(fontWeight: FontWeight.bold)),
                    Text(timeStr,
                        style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurface.withAlpha(128))),
                  ],
                ),
                const SizedBox(height: 4),
                Row(children: [
                  Text(oldName,
                      style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurface.withAlpha(160))),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 4),
                    child: Icon(Icons.arrow_forward, size: 14),
                  ),
                  Text(newName,
                      style: theme.textTheme.bodySmall?.copyWith(
                          fontWeight: FontWeight.bold)),
                ]),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _NoteItem extends StatelessWidget {
  final HelpdeskNote note;
  final bool isOwn;
  final String Function(String?) resolveDisplay;

  const _NoteItem(
      {required this.note,
      required this.isOwn,
      required this.resolveDisplay});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final timeStr = DateFormat('HH:mm, d.M.yyyy').format(note.createdAt);

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: isOwn
            ? theme.colorScheme.primaryContainer.withAlpha(80)
            : theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(resolveDisplay(note.authorUsername),
                  style: const TextStyle(
                      fontWeight: FontWeight.bold, fontSize: 13)),
              Text(timeStr,
                  style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withAlpha(128))),
            ],
          ),
          if (note.noteText.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(note.noteText, style: theme.textTheme.bodyMedium),
          ],
          if (note.attachmentUrl != null &&
              note.attachmentUrl!.isNotEmpty) ...[
            const SizedBox(height: 4),
            Row(children: [
              Icon(Icons.attach_file,
                  size: 14, color: theme.colorScheme.primary),
              const SizedBox(width: 4),
              Text('קובץ מצורף',
                  style: TextStyle(
                      color: theme.colorScheme.primary,
                      fontSize: 12,
                      decoration: TextDecoration.underline)),
            ]),
          ],
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Attachment row – displayed in ticket detail when a file was attached.
// ---------------------------------------------------------------------------

class _AttachmentRow extends StatelessWidget {
  final String url;

  const _AttachmentRow({required this.url});

  static const _imageExtensions = {
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif',
  };

  bool get _isImage {
    final ext = url.split('?').first.split('.').last.toLowerCase();
    return _imageExtensions.contains(ext);
  }

  Future<void> _open(BuildContext context) async {
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('לא ניתן לפתוח את הקובץ')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.attach_file, size: 20, color: theme.colorScheme.primary),
          const SizedBox(width: 10),
          SizedBox(
            width: 90,
            child: Text('קובץ מצורף',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.onSurface.withAlpha(150))),
          ),
          Expanded(
            child: _isImage
                ? GestureDetector(
                    onTap: () => _open(context),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.network(
                        url,
                        height: 160,
                        width: double.infinity,
                        fit: BoxFit.cover,
                        loadingBuilder: (context, child, progress) {
                          if (progress == null) return child;
                          return SizedBox(
                            height: 160,
                            child: Center(
                              child: CircularProgressIndicator(
                                value: progress.expectedTotalBytes != null
                                    ? progress.cumulativeBytesLoaded /
                                        progress.expectedTotalBytes!
                                    : null,
                              ),
                            ),
                          );
                        },
                        errorBuilder: (_, __, ___) => GestureDetector(
                          onTap: () => _open(context),
                          child: Row(children: [
                            Icon(Icons.broken_image,
                                color: theme.colorScheme.primary),
                            const SizedBox(width: 4),
                            Text('פתח קובץ',
                                style: TextStyle(
                                    color: theme.colorScheme.primary,
                                    decoration: TextDecoration.underline)),
                          ]),
                        ),
                      ),
                    ),
                  )
                : GestureDetector(
                    onTap: () => _open(context),
                    child: Row(children: [
                      Icon(Icons.open_in_new,
                          size: 16, color: theme.colorScheme.primary),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text(
                          url.split('/').last.split('?').first,
                          style: TextStyle(
                              color: theme.colorScheme.primary,
                              decoration: TextDecoration.underline),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ]),
                  ),
          ),
        ],
      ),
    );
  }
}
