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
import '../../../shared/widgets/authenticated_image.dart';
import '../../auth/presentation/auth_state.dart';
import '../../../core/utils/toast_utils.dart';
import 'helpdesk_user_management_screen.dart';

// ---------------------------------------------------------------------------
// Helpdesk State
// ---------------------------------------------------------------------------

class _HelpdeskDepartmentIconOption {
  final String key;
  final String label;
  final IconData icon;
  const _HelpdeskDepartmentIconOption(this.key, this.label, this.icon);
}

const List<_HelpdeskDepartmentIconOption> _kHelpdeskDepartmentIconOptions = [
  _HelpdeskDepartmentIconOption('computer', 'מחשבים / מערכות מידע', Icons.computer),
  _HelpdeskDepartmentIconOption('build', 'אחזקה / כלים', Icons.build),
  _HelpdeskDepartmentIconOption('local_pharmacy', 'בית מרקחת', Icons.local_pharmacy),
  _HelpdeskDepartmentIconOption('biotech', 'הנדסה רפואית', Icons.biotech),
  _HelpdeskDepartmentIconOption('support_agent', 'מוקד שירות', Icons.support_agent),
  _HelpdeskDepartmentIconOption('medical_services', 'שירותים רפואיים', Icons.medical_services),
  _HelpdeskDepartmentIconOption('electrical_services', 'חשמל', Icons.electrical_services),
  _HelpdeskDepartmentIconOption('plumbing', 'אינסטלציה', Icons.plumbing),
  _HelpdeskDepartmentIconOption('cleaning_services', 'ניקיון', Icons.cleaning_services),
  _HelpdeskDepartmentIconOption('inventory_2', 'מחסן', Icons.inventory_2),
  _HelpdeskDepartmentIconOption('security', 'אבטחה', Icons.security),
  _HelpdeskDepartmentIconOption('apartment', 'כללי', Icons.apartment),
];
final RegExp _kMaterialIconLigaturePattern = RegExp(r'^[a-z0-9_]+$');

IconData? _departmentIconDataFromKey(String? iconKey) {
  final key = (iconKey ?? '').trim();
  if (key.isEmpty) return null;
  for (final option in _kHelpdeskDepartmentIconOptions) {
    if (option.key == key) return option.icon;
  }
  return null;
}

Widget _buildDepartmentIcon(String? iconKey, {double size = 22}) {
  final iconData = _departmentIconDataFromKey(iconKey);
  if (iconData != null) {
    return Icon(iconData, size: size);
  }
  final text = (iconKey ?? '').trim();
  if (text.isNotEmpty) {
    if (_kMaterialIconLigaturePattern.hasMatch(text)) {
      return Text(
        text,
        style: TextStyle(
          fontFamily: 'MaterialIcons',
          fontSize: size,
          height: 1,
        ),
      );
    }
    return Text(text, style: TextStyle(fontSize: size));
  }
  return Icon(Icons.apartment, size: size);
}

class HelpdeskState {
  final List<HelpdeskTicket> ongoing;
  final List<HelpdeskTicket> past;
  final List<HelpdeskTicket> assigned;
  final HelpdeskMyRole? myRole;
  final List<HelpdeskTicket> editorTickets;
  final List<HelpdeskManagedUser> handlers;
  final List<HelpdeskDepartmentEntry> departments;
  final bool isLoading;
  final String? error;

  const HelpdeskState({
    this.ongoing = const [],
    this.past = const [],
    this.assigned = const [],
    this.myRole,
    this.editorTickets = const [],
    this.handlers = const [],
    this.departments = const [],
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
    List<HelpdeskDepartmentEntry>? departments,
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
      departments: departments ?? this.departments,
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

  /// Exposes the currently logged-in user for API calls made from outside the notifier.
  String get currentUser => _currentUser ?? '';

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
      final results = await Future.wait([
        _api.getHelpdeskDashboard(_currentUser!),
        _api.getUserAccessibleDepartments().catchError(
              (_) => _api
                  .getActiveHelpdeskDepartments()
                  .catchError((__) => <HelpdeskDepartmentEntry>[])),
      ]);
      final dashboard = results[0] as HelpdeskDashboard;
      final departments = results[1] as List<HelpdeskDepartmentEntry>;
      _lastLoadAt = DateTime.now();
      state = HelpdeskState(
        ongoing: dashboard.ongoing,
        past: dashboard.past,
        assigned: dashboard.assigned,
        myRole: dashboard.myRole,
        editorTickets: dashboard.editorTickets ?? const [],
        handlers: dashboard.handlers ?? const [],
        departments: departments,
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
    required String department,
    required String priority,
    String? location,
    String? phone,
    String? attachmentUrl,
    Map<String, dynamic> customFields = const {},
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
        customFields: customFields,
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

  Future<List<HelpdeskDepartmentEntry>> loadActiveDepartments({
    bool force = false,
  }) async {
    if (_currentUser == null) {
      throw Exception('יש להתחבר תחילה');
    }

    if (!force && state.departments.isNotEmpty) {
      return state.departments;
    }

    try {
      final departments = await _api
          .getUserAccessibleDepartments()
          .catchError((_) => _api.getActiveHelpdeskDepartments());
      state = state.copyWith(departments: departments, error: null);
      return departments;
    } catch (e) {
      state = state.copyWith(
        error: 'שגיאה בטעינת המחלקות: ${e.toString()}',
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
    await _api.updateHelpdeskTicketStatus(ticketId, status, _currentUser!);
    await loadTickets(force: true);
  }

  Future<void> transferTicketDepartment(int ticketId, int departmentId) async {
    if (_currentUser == null) throw Exception('יש להתחבר תחילה');
    await _api.transferHelpdeskTicketDepartment(ticketId, departmentId, _currentUser!);
    await loadTickets(force: true);
  }
}

final helpdeskProvider = NotifierProvider<HelpdeskNotifier, HelpdeskState>(() {
  return HelpdeskNotifier();
});


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

HelpdeskDepartmentEntry? _findDepartmentByName(
  List<HelpdeskDepartmentEntry> departments,
  String departmentName,
) {
  final normalizedDepartment = departmentName.trim();
  for (final department in departments) {
    if (department.name.trim() == normalizedDepartment) {
      return department;
    }
  }
  return null;
}

HelpdeskTicketStatus? _findStatusDefinition(
  List<HelpdeskDepartmentEntry> departments,
  String departmentName,
  String statusKey,
) {
  final department = _findDepartmentByName(departments, departmentName);
  if (department == null) return null;
  final normalizedStatusKey = statusKey.trim();
  for (final status in department.ticketStatuses) {
    if (status.key.trim() == normalizedStatusKey) {
      return status;
    }
  }
  return null;
}

bool _isTerminalStatusForDepartment(
  List<HelpdeskDepartmentEntry> departments,
  String departmentName,
  String statusKey,
) {
  final status = _findStatusDefinition(departments, departmentName, statusKey);
  if (status != null) return status.isTerminal;
  return statusKey == 'closed' || statusKey == 'resolved';
}

bool _isDefaultStatusForDepartment(
  List<HelpdeskDepartmentEntry> departments,
  String departmentName,
  String statusKey,
) {
  final department = _findDepartmentByName(departments, departmentName);
  final normalizedStatusKey = statusKey.trim();
  if (department != null && department.ticketStatuses.isNotEmpty) {
    for (final status in department.ticketStatuses) {
      if (status.isDefault) {
        return status.key.trim() == normalizedStatusKey;
      }
    }
    return department.ticketStatuses.first.key.trim() == normalizedStatusKey;
  }
  return normalizedStatusKey == 'open';
}

Color _statusColorFromHex(String? colorHex) {
  final normalized = (colorHex ?? '').trim();
  if (normalized.length == 7 && normalized.startsWith('#')) {
    final parsed = int.tryParse(normalized.substring(1), radix: 16);
    if (parsed != null) {
      return Color(0xFF000000 | parsed);
    }
  }
  return const Color(0xFF757575);
}

String _statusLabel(
  List<HelpdeskDepartmentEntry> departments,
  String departmentName,
  String status,
) {
  final resolved = _findStatusDefinition(departments, departmentName, status);
  if (resolved != null && resolved.label.trim().isNotEmpty) {
    return resolved.label;
  }
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

Color _statusColor(
  List<HelpdeskDepartmentEntry> departments,
  String departmentName,
  String status,
) {
  final resolved = _findStatusDefinition(departments, departmentName, status);
  if (resolved != null) {
    return _statusColorFromHex(resolved.colorHex);
  }
  switch (status) {
    case 'open':
      return const Color(0xFF2E7D32);
    case 'in_progress':
      return const Color(0xFFE65100);
    case 'resolved':
      return const Color(0xFF1565C0);
    case 'closed':
      return const Color(0xFF757575);
    default:
      return const Color(0xFF757575);
  }
}

List<HelpdeskTicketStatus> _defaultDepartmentTicketStatuses() =>
    const <HelpdeskTicketStatus>[
      HelpdeskTicketStatus(
        key: 'open',
        label: 'פתוחה',
        colorHex: '#2E7D32',
        sortOrder: 0,
        isDefault: true,
      ),
      HelpdeskTicketStatus(
        key: 'in_progress',
        label: 'בטיפול',
        colorHex: '#E65100',
        sortOrder: 1,
      ),
      HelpdeskTicketStatus(
        key: 'resolved',
        label: 'טופלה',
        colorHex: '#1565C0',
        sortOrder: 2,
        isTerminal: true,
      ),
      HelpdeskTicketStatus(
        key: 'closed',
        label: 'סגורה',
        colorHex: '#757575',
        sortOrder: 3,
        isTerminal: true,
      ),
    ];

String _totalDurationLabel(
  List<HelpdeskStatusHistoryEntry> history,
  List<HelpdeskDepartmentEntry> departments,
  String departmentName,
) {
  if (history.isEmpty) return '';
  // History is ordered newest-first (DESC). The opening entry is the last one.
  final openTime = history.last.createdAt;
  HelpdeskStatusHistoryEntry? closedEntry;
  // Iterate from newest to oldest to find the most recent terminal entry.
  for (final h in history) {
    if (_isTerminalStatusForDepartment(departments, departmentName, h.newStatus)) {
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
      ...assignedExtras.where(
        (ticket) => !_isTerminalStatusForDepartment(
          state.departments,
          ticket.department,
          ticket.status,
        ),
      ),
    ];
    final pastTickets = [
      ...state.past,
      ...assignedExtras.where(
        (ticket) => _isTerminalStatusForDepartment(
          state.departments,
          ticket.department,
          ticket.status,
        ),
      ),
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
                  Row(
                    children: [
                     if (state.isLoading)
                       const SizedBox(
                         width: 20,
                         height: 20,
                         child: CircularProgressIndicator(strokeWidth: 2),
                       ),
                     IconButton(
                       icon: const Icon(Icons.refresh),
                       tooltip: 'רענן',
                       onPressed: () => ref
                           .read(helpdeskProvider.notifier)
                           .loadTickets(force: true),
                     ),
                    ],
                  ),
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

  Future<void> _showDepartmentSelectionDialog(BuildContext ctx) async {
    final overlay = Overlay.of(ctx, rootOverlay: true);
    var depts = ref.read(helpdeskProvider).departments;

    if (depts.isEmpty) {
      try {
        depts = await ref
            .read(helpdeskProvider.notifier)
            .loadActiveDepartments(force: true);
      } catch (_) {
        if (ctx.mounted) {
          showTopToastOnOverlay(overlay, 'לא ניתן לטעון את המחלקות כרגע');
        }
        return;
      }
    }

    if (!ctx.mounted) return;

    if (depts.isEmpty) {
      showTopToastOnOverlay(overlay, 'לא נמצאו מחלקות פעילות');
      return;
    }

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
                ...depts.map((dept) => Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: OutlinedButton.icon(
                    onPressed: () {
                      Navigator.of(ctx).pop();
                      _showTicketFormDialog(ctx, dept.name);
                    },
                    icon: _buildDepartmentIcon(dept.icon, size: 20),
                    label: Text(dept.name),
                    style: OutlinedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 16)),
                  ),
                )),
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

  void _showTicketFormDialog(BuildContext ctx, String dept) {
    final subjectCtrl = TextEditingController();
    final descCtrl = TextEditingController();
    final locationCtrl = TextEditingController();
    // Pre-fill with the phone number that was used to log in.
    final userPhone =
        ref.read(currentUserPhoneProvider) ?? ref.read(currentUserProvider) ?? '';
    final phoneCtrl = TextEditingController(text: userPhone);
    String priority = 'normal';
    List<String> locations = [];
    bool loadingLoc = true;
    bool locFetchStarted = false;

    // Department custom form fields
    List<HelpdeskTicketFormField> formFields = [];
    HelpdeskInitialFormConfig initialForm = const HelpdeskInitialFormConfig();
    Map<String, TextEditingController> customCtrlMap = {};
    Map<String, String> radioValues = {};
    Map<String, String> selectValues = {};
    bool formFieldsLoaded = false;

    void disposeCustomCtrls() {
      for (final c in customCtrlMap.values) {
        c.dispose();
      }
    }

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
          // Load locations once
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
          // Load department form fields once
          if (!formFieldsLoaded) {
            formFieldsLoaded = true;
            ref.read(chatApiServiceProvider)
                .getHelpdeskDepartmentTicketFormConfig(
                  ref.read(helpdeskProvider.notifier).currentUser,
                  dept,
                )
                .then((config) {
              final fields = config.fields;
              // Build controllers with initial values
              final ctrlMap = <String, TextEditingController>{};
              final radioMap = <String, String>{};
              final selectMap = <String, String>{};
              for (final f in fields) {
                if (f.type == HelpdeskTicketFormFieldType.input ||
                    f.type == HelpdeskTicketFormFieldType.textarea) {
                  ctrlMap[f.id] =
                      TextEditingController(text: f.initialValue);
                } else if (f.type == HelpdeskTicketFormFieldType.radio) {
                  radioMap[f.id] = f.initialValue.isNotEmpty &&
                          f.options.contains(f.initialValue)
                      ? f.initialValue
                      : (f.options.isNotEmpty ? f.options.first : '');
                } else if (f.type == HelpdeskTicketFormFieldType.select) {
                  selectMap[f.id] = f.initialValue.isNotEmpty &&
                          f.options.contains(f.initialValue)
                      ? f.initialValue
                      : '';
                }
              }
              setSt(() {
                formFields = fields;
                initialForm = config.initialForm;
                customCtrlMap = ctrlMap;
                radioValues = radioMap;
                selectValues = selectMap;
              });
            }).catchError((error) {
              // Non-critical — continue with empty dynamic fields
              debugPrint('Failed to load helpdesk department form config: $error');
            });
          }

          // Build dynamic field widgets
          final List<Widget> dynamicFieldWidgets = [];
          for (final f in formFields) {
            dynamicFieldWidgets.add(const SizedBox(height: 16));
            switch (f.type) {
              case HelpdeskTicketFormFieldType.input:
                dynamicFieldWidgets.add(TextField(
                  controller: customCtrlMap[f.id],
                  textDirection: ui.TextDirection.rtl,
                  keyboardType: f.inputType == HelpdeskTicketFormInputType.number
                      ? TextInputType.number
                      : f.inputType == HelpdeskTicketFormInputType.tel
                          ? TextInputType.phone
                          : TextInputType.text,
                  decoration: InputDecoration(
                    labelText: f.required ? '${f.label} *' : f.label,
                    hintText: f.placeholder.isNotEmpty ? f.placeholder : null,
                    border: const OutlineInputBorder(),
                  ),
                ));
              case HelpdeskTicketFormFieldType.textarea:
                dynamicFieldWidgets.add(TextField(
                  controller: customCtrlMap[f.id],
                  textDirection: ui.TextDirection.rtl,
                  maxLines: 4,
                  decoration: InputDecoration(
                    labelText: f.required ? '${f.label} *' : f.label,
                    hintText: f.placeholder.isNotEmpty ? f.placeholder : null,
                    border: const OutlineInputBorder(),
                  ),
                ));
              case HelpdeskTicketFormFieldType.radio:
                dynamicFieldWidgets.add(Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        f.required ? '${f.label} *' : f.label,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ),
                    ...f.options.map((opt) => RadioListTile<String>(
                          title: Text(opt),
                          value: opt,
                          groupValue: radioValues[f.id] ?? '',
                          onChanged: (v) {
                            if (v != null) setSt(() => radioValues[f.id] = v);
                          },
                          contentPadding: EdgeInsets.zero,
                          dense: true,
                        )),
                  ],
                ));
              case HelpdeskTicketFormFieldType.select:
                dynamicFieldWidgets.add(Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        f.required ? '${f.label} *' : f.label,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ),
                    Autocomplete<String>(
                      initialValue: TextEditingValue(
                          text: selectValues[f.id] ?? ''),
                      optionsBuilder: (tv) {
                        final query = tv.text.trim().toLowerCase();
                        if (query.isEmpty) return f.options;
                        return f.options.where(
                            (o) => o.toLowerCase().contains(query));
                      },
                      onSelected: (v) {
                        setSt(() => selectValues[f.id] = v);
                      },
                      fieldViewBuilder: (ctx2, ctrl, fn, oec) {
                        return TextField(
                          controller: ctrl,
                          focusNode: fn,
                          onEditingComplete: oec,
                          textDirection: ui.TextDirection.rtl,
                          decoration: InputDecoration(
                            labelText: f.placeholder.isNotEmpty
                                ? f.placeholder
                                : 'חיפוש אפשרות...',
                            border: const OutlineInputBorder(),
                            suffixIcon: (selectValues[f.id] ?? '').isNotEmpty
                                ? const Icon(Icons.check,
                                    color: Colors.green)
                                : null,
                          ),
                        );
                      },
                    ),
                    if ((selectValues[f.id] ?? '').isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Row(
                          children: [
                            const Icon(Icons.check_circle_outline,
                                size: 16, color: Colors.green),
                            const SizedBox(width: 4),
                            Expanded(
                                child: Text(selectValues[f.id]!,
                                    style: const TextStyle(
                                        fontSize: 13,
                                        color: Colors.green))),
                            TextButton(
                              onPressed: () =>
                                  setSt(() => selectValues[f.id] = ''),
                              child: const Text('נקה',
                                  style: TextStyle(fontSize: 12)),
                            ),
                          ],
                        ),
                      ),
                  ],
                ));
            }
          }

          return Directionality(
          textDirection: ui.TextDirection.rtl,
          child: AlertDialog(
            title: Text('קריאה חדשה - $dept'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (initialForm.showTitle) ...[
                    TextField(
                      controller: subjectCtrl,
                      textDirection: ui.TextDirection.rtl,
                      decoration: const InputDecoration(
                          labelText: 'כותרת הקריאה *',
                          border: OutlineInputBorder()),
                    ),
                    const SizedBox(height: 16),
                  ],
                  if (initialForm.showDescription) ...[
                    TextField(
                      controller: descCtrl,
                      textDirection: ui.TextDirection.rtl,
                      maxLines: 4,
                      decoration: const InputDecoration(
                          labelText: 'תיאור הבעיה',
                          border: OutlineInputBorder()),
                    ),
                    const SizedBox(height: 16),
                  ],
                  if (initialForm.showLocation) ...[
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
                  ],
                  if (initialForm.showPhone) ...[
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
                  ],
                  if (initialForm.showPriority) ...[
                    DropdownButtonFormField<String>(
                      initialValue: priority,
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
                  ],
                  // Dynamic department form fields
                  ...dynamicFieldWidgets,
                  if (initialForm.showAttachment) ...[
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
                ],
              ),
            ),
            actions: [
              TextButton(
                  onPressed: () {
                    disposeCustomCtrls();
                    Navigator.of(context).pop();
                  },
                  child: const Text('ביטול')),
              ElevatedButton(
                onPressed: isUploadingAttachment
                    ? null
                    : () async {
                        if (initialForm.showTitle &&
                            subjectCtrl.text.trim().isEmpty) {
                          showTopToast(context, 'יש להזין כותרת');
                          return;
                        }
                        if (initialForm.showLocation &&
                            locationCtrl.text.trim().isEmpty) {
                          showTopToast(context, 'יש להזין מיקום');
                          return;
                        }
                        // Validate required dynamic fields
                        for (final f in formFields) {
                          if (!f.required) continue;
                          String val = '';
                          if (f.type == HelpdeskTicketFormFieldType.input ||
                              f.type == HelpdeskTicketFormFieldType.textarea) {
                            val = customCtrlMap[f.id]?.text.trim() ?? '';
                          } else if (f.type ==
                              HelpdeskTicketFormFieldType.radio) {
                            val = radioValues[f.id] ?? '';
                          } else if (f.type ==
                              HelpdeskTicketFormFieldType.select) {
                            val = selectValues[f.id] ?? '';
                          }
                          if (val.isEmpty) {
                            showTopToast(
                                context, 'יש להזין ערך בשדה: ${f.label}');
                            return;
                          }
                        }

                        // Build customFields map
                        final customFields = <String, dynamic>{};
                        for (final f in formFields) {
                          dynamic val;
                          if (f.type == HelpdeskTicketFormFieldType.input ||
                              f.type == HelpdeskTicketFormFieldType.textarea) {
                            val = customCtrlMap[f.id]?.text.trim() ?? '';
                          } else if (f.type ==
                              HelpdeskTicketFormFieldType.radio) {
                            val = radioValues[f.id] ?? '';
                          } else if (f.type ==
                              HelpdeskTicketFormFieldType.select) {
                            val = selectValues[f.id] ?? '';
                          }
                          if (val != null &&
                              val.toString().isNotEmpty) {
                            if (f.type == HelpdeskTicketFormFieldType.input &&
                                f.inputType ==
                                    HelpdeskTicketFormInputType.number) {
                              final parsed = num.tryParse(val.toString());
                              if (parsed != null) {
                                customFields[f.id] = parsed;
                              }
                            } else {
                              customFields[f.id] = val.toString();
                            }
                          }
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

                        final subjectValue = initialForm.showTitle
                            ? subjectCtrl.text.trim()
                            : 'פנייה חדשה';
                        final descriptionValue = initialForm.showDescription
                            ? descCtrl.text.trim()
                            : 'ללא תיאור';
                        final locationValue = initialForm.showLocation &&
                                locationCtrl.text.trim().isNotEmpty
                            ? locationCtrl.text.trim()
                            : null;
                        final phoneValue = initialForm.showPhone &&
                                phoneCtrl.text.trim().isNotEmpty
                            ? phoneCtrl.text.trim()
                            : null;

                        disposeCustomCtrls();
                        Navigator.of(context).pop();
                        try {
                          await ref
                              .read(helpdeskProvider.notifier)
                              .createTicket(
                                subject: subjectValue,
                                description: descriptionValue,
                                department: dept,
                                priority:
                                    initialForm.showPriority ? priority : 'normal',
                                location: locationValue,
                                phone: phoneValue,
                                attachmentUrl: attachmentUrl,
                                customFields: customFields,
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
class TicketManagerScreen extends ConsumerStatefulWidget {
  const TicketManagerScreen({super.key});

  @override
  ConsumerState<TicketManagerScreen> createState() => _TicketManagerScreenState();
}

class _TicketManagerScreenState extends ConsumerState<TicketManagerScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(helpdeskProvider.notifier).loadTickets(force: true);
    });
  }

  @override
  Widget build(BuildContext context) {
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
                  Row(
                    children: [
                     if (state.isLoading)
                       const SizedBox(
                         width: 20,
                         height: 20,
                         child: CircularProgressIndicator(strokeWidth: 2),
                       ),
                     if (state.myRole?.role == HelpdeskRole.admin)
                       IconButton(
                         icon: const Icon(Icons.people_alt_outlined),
                         tooltip: 'ניהול משתמשי מוקד',
                         onPressed: () => Navigator.of(context).push(
                           MaterialPageRoute(
                             builder: (_) => HelpdeskUserManagementScreen(
                               currentUser:
                                   ref.read(helpdeskProvider.notifier).currentUser,
                             ),
                           ),
                         ),
                       ),
                     IconButton(
                       icon: const Icon(Icons.refresh),
                       tooltip: 'רענן',
                       onPressed: () => ref
                           .read(helpdeskProvider.notifier)
                           .loadTickets(force: true),
                     ),
                    ],
                  ),
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
  String? _selectedDepartmentFilter;
  String? _selectedStatusFilter;

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

    final departmentEntries = ref.watch(helpdeskProvider).departments;
    final availableDepartments = {
      for (final ticket in visibleTickets)
        if (ticket.department.trim().isNotEmpty) ticket.department.trim(),
    }.toList();
    availableDepartments.sort((a, b) {
      final aIndex = departmentEntries.indexWhere((department) => department.name.trim() == a);
      final bIndex = departmentEntries.indexWhere((department) => department.name.trim() == b);
      if (aIndex == -1 && bIndex == -1) {
        return a.compareTo(b);
      }
      if (aIndex == -1) return 1;
      if (bIndex == -1) return -1;
      return aIndex.compareTo(bIndex);
    });

    final selectedDepartmentFilter = availableDepartments.contains(_selectedDepartmentFilter)
        ? _selectedDepartmentFilter
        : null;
    final departmentFilteredTickets = selectedDepartmentFilter == null
        ? visibleTickets
        : visibleTickets
            .where((ticket) => ticket.department.trim() == selectedDepartmentFilter)
            .toList();

    final availableStatuses = <String, String>{};
    for (final ticket in departmentFilteredTickets) {
      final statusKey = ticket.status.trim();
      if (statusKey.isEmpty) continue;
      availableStatuses.putIfAbsent(
        statusKey,
        () => _statusLabel(departmentEntries, ticket.department, statusKey),
      );
    }
    final availableStatusKeys = availableStatuses.keys.toList()
      ..sort((a, b) => (availableStatuses[a] ?? a).compareTo(availableStatuses[b] ?? b));

    final selectedStatusFilter = availableStatusKeys.contains(_selectedStatusFilter)
        ? _selectedStatusFilter
        : null;
    final filteredTickets = selectedStatusFilter == null
        ? departmentFilteredTickets
        : departmentFilteredTickets
            .where((ticket) => ticket.status.trim() == selectedStatusFilter)
            .toList();

    final newTickets = filteredTickets
        .where((t) => _isDefaultStatusForDepartment(
              departmentEntries,
              t.department,
              t.status,
            ))
        .toList();
    final inProgressTickets = filteredTickets
        .where((t) =>
            !_isDefaultStatusForDepartment(
              departmentEntries,
              t.department,
              t.status,
            ) &&
            !_isTerminalStatusForDepartment(
              departmentEntries,
              t.department,
              t.status,
            ))
        .toList();
    final closedTickets = filteredTickets
        .where((t) => _isTerminalStatusForDepartment(
              departmentEntries,
              t.department,
              t.status,
            ))
        .toList();

    final String roleLabel;
    switch (role.role) {
      case HelpdeskRole.admin:
        roleLabel = 'Admin';
        break;
      case HelpdeskRole.relatedUser:
        roleLabel = 'RelatedUser';
        break;
      case HelpdeskRole.viewer:
        roleLabel = 'Viewer';
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
            if (role.role == HelpdeskRole.admin)
              IconButton(
                icon: const Icon(Icons.settings),
                tooltip: 'הגדרות מחלקות',
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => _DepartmentSettingsScreen(currentUser: currentUser),
                  ),
                ),
              ),
          ]),
        ),
        if (availableDepartments.length > 1)
          Padding(
           padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
           child: DropdownButtonFormField<String?>(
             value: selectedDepartmentFilter,
             decoration: const InputDecoration(
               labelText: 'סינון לפי מחלקה',
               border: OutlineInputBorder(),
               isDense: true,
             ),
             items: [
               const DropdownMenuItem<String?>(
                 value: null,
                 child: Text('כל המחלקות'),
               ),
               ...availableDepartments.map(
                 (department) => DropdownMenuItem<String?>(
                   value: department,
                   child: Text(department),
                 ),
               ),
             ],
             onChanged: (value) {
               setState(() {
                 _selectedDepartmentFilter = value;
               });
             },
           ),
         ),
        if (availableStatusKeys.length > 1)
         Padding(
           padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
           child: DropdownButtonFormField<String?>(
             value: selectedStatusFilter,
             decoration: const InputDecoration(
               labelText: 'סינון לפי סטטוס',
               border: OutlineInputBorder(),
               isDense: true,
             ),
             items: [
               const DropdownMenuItem<String?>(
                 value: null,
                 child: Text('כל הסטטוסים'),
               ),
               ...availableStatusKeys.map(
                 (statusKey) => DropdownMenuItem<String?>(
                   value: statusKey,
                   child: Text(availableStatuses[statusKey] ?? statusKey),
                 ),
               ),
             ],
             onChanged: (value) {
               setState(() {
                 _selectedStatusFilter = value;
               });
             },
           ),
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
                child: _StatusChip(
                  status: ticket.status,
                  departmentName: ticket.department,
                ),
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
        departments: state.departments,
        currentUser: currentUser,
        isManagerView: isManagerView,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Ticket card sub-widgets
// ---------------------------------------------------------------------------

class _StatusChip extends ConsumerWidget {
  final String status;
  final String departmentName;

  const _StatusChip({
    required this.status,
    required this.departmentName,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final departments = ref.watch(helpdeskProvider).departments;
    final color = _statusColor(departments, departmentName, status);
    final label = _statusLabel(departments, departmentName, status);
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
  final List<HelpdeskDepartmentEntry> departments;
  final String currentUser;
  final bool isManagerView;

  const _TicketDetailSheet({
    required this.ticket,
    required this.myRole,
    required this.handlers,
    required this.departments,
    required this.currentUser,
    this.isManagerView = false,
  });

  @override
  ConsumerState<_TicketDetailSheet> createState() => _TicketDetailSheetState();
}

class _TicketDetailSheetState extends ConsumerState<_TicketDetailSheet> {
  static const String _handlerDebugSource = 'HelpdeskScreen';
  List<HelpdeskStatusHistoryEntry>? _history;
  List<HelpdeskHandlerHistoryEntry>? _handlerHistory;
  List<HelpdeskNote>? _notes;
  bool _loadingHistory = true;
  bool _loadingHandlerHistory = true;
  bool _loadingNotes = true;
  String? _historyError;

  String? _selectedHandler;
  int? _selectedDepartmentId;
  String _selectedStatus = '';
  bool _savingHandler = false;
  bool _savingDepartment = false;
  bool _savingStatus = false;
  String? _departmentError;
  String? _handlerError;
  String? _statusError;
  List<HelpdeskManagedUser> _allHandlers = const <HelpdeskManagedUser>[];

  final _noteCtrl = TextEditingController();
  bool _submittingNote = false;
  String? _noteError;

  HelpdeskTicket get _ticket => widget.ticket;
  String get _currentUser => widget.currentUser;

  bool get _canManageHandler {
    if (!widget.isManagerView) return false;
    if (_isTerminalStatusForDepartment(widget.departments, _ticket.department, _ticket.status)) {
      return false;
    }
    if (widget.myRole == null) return false;
    if (widget.myRole!.role == HelpdeskRole.viewer) return false;
    final departments = widget.myRole!.allDepartments;
    // relatedUser: allowed only for tickets they created or are handling
    if (widget.myRole!.role == HelpdeskRole.relatedUser) {
      return _ticket.creatorUsername == _currentUser ||
          _ticket.handlerUsername == _currentUser;
    }
    // admin can manage any ticket; editor is limited to own department
    return widget.myRole!.role == HelpdeskRole.admin ||
        departments.contains(_ticket.department);
  }

  bool get _canTransferDepartment {
    if (!widget.isManagerView) return false;
    if (_isTerminalStatusForDepartment(widget.departments, _ticket.department, _ticket.status)) {
      return false;
    }
    final myRole = widget.myRole;
    if (myRole == null || myRole.role == HelpdeskRole.relatedUser) return false;
    if (myRole.role == HelpdeskRole.viewer) return false;
    return myRole.role == HelpdeskRole.admin || myRole.allDepartments.contains(_ticket.department);
  }

  bool get _canChangeStatus {
    if (!widget.isManagerView) return false;
    if (_isTerminalStatusForDepartment(widget.departments, _ticket.department, _ticket.status)) {
      return false;
    }
    if (_ticket.creatorUsername == _currentUser) return true;
    if (_ticket.handlerUsername == _currentUser) return true;
    if (widget.myRole != null &&
        widget.myRole!.role != HelpdeskRole.viewer &&
        widget.myRole!.allDepartments.contains(_ticket.department)) {
      return true;
    }
    return false;
  }

  bool get _canAddNote {
    if (_ticket.creatorUsername == _currentUser) return true;
    if (_ticket.handlerUsername == _currentUser) return true;
    final myRole = widget.myRole;
    if (myRole == null || myRole.role == HelpdeskRole.viewer) return false;
    return myRole.role == HelpdeskRole.admin ||
        myRole.allDepartments.contains(_ticket.department);
  }

  @override
  void initState() {
    super.initState();
    _selectedHandler = _ticket.handlerUsername;
    _selectedDepartmentId = _findDepartmentIdByName(_ticket.department);
    _selectedStatus = _ticket.status;
    _allHandlers = List<HelpdeskManagedUser>.from(widget.handlers);
    _logHandlerDebug('TicketDetail.initState', {
      'ticketId': _ticket.id,
      'ticketDepartment': _ticket.department,
      'currentUser': _currentUser,
      'initialHandlersCount': widget.handlers.length,
      'initialHandlers': widget.handlers,
    });
    _syncSelectedHandlerWithDepartment();
    _loadData();
  }

  int? _findDepartmentIdByName(String departmentName) {
    for (final department in widget.departments) {
      if (department.name == departmentName) return department.id;
    }
    return null;
  }

  HelpdeskDepartmentEntry? _findSelectedDepartment() {
    final selectedDepartmentId = _selectedDepartmentId;
    if (selectedDepartmentId == null) return null;
    for (final department in widget.departments) {
      if (department.id == selectedDepartmentId) return department;
    }
    return null;
  }

  String _selectedDepartmentName() {
    return _findSelectedDepartment()?.name ?? _ticket.department;
  }

  List<HelpdeskTicketStatus> _availableStatusesForTicketDepartment([
    String? departmentName,
  ]) {
    final selectedDepartment = _findDepartmentByName(
      widget.departments,
      (departmentName ?? _selectedDepartmentName()).trim(),
    );
    if (selectedDepartment != null && selectedDepartment.ticketStatuses.isNotEmpty) {
      return List<HelpdeskTicketStatus>.from(selectedDepartment.ticketStatuses)
        ..sort((a, b) => a.sortOrder.compareTo(b.sortOrder));
    }
    return _defaultDepartmentTicketStatuses();
  }

  void _logHandlerDebug(String event, Map<String, Object?> payload) {
    if (!kDebugMode) return;
    debugPrint('[HelpdeskDebug][$event] {source: $_handlerDebugSource, ${payload.entries.map((entry) => '${entry.key}: ${entry.value}').join(', ')}}');
  }

  List<HelpdeskManagedUser> _eligibleHandlersForDepartment() {
    final targetDepartment = _selectedDepartmentName().trim();
    if (targetDepartment.isEmpty) return const <HelpdeskManagedUser>[];
    final eligibleHandlers = _allHandlers
        .where(
          (handler) =>
              handler.role != HelpdeskRole.viewer &&
              handler.allDepartments
                  .map((department) => department.trim())
                  .contains(targetDepartment),
        )
        .toList()
      ..sort(
        (a, b) => _resolveDisplay(a.username)
            .toLowerCase()
            .compareTo(_resolveDisplay(b.username).toLowerCase()),
      );
    _logHandlerDebug('TicketDetail.eligibleHandlers', {
      'ticketId': _ticket.id,
      'targetDepartment': targetDepartment,
      'allHandlersCount': _allHandlers.length,
      'eligibleHandlersCount': eligibleHandlers.length,
      'allHandlers': _allHandlers,
      'eligibleHandlers': eligibleHandlers,
    });
    return eligibleHandlers;
  }

  void _syncSelectedHandlerWithDepartment() {
    final eligibleUsernames = _eligibleHandlersForDepartment()
        .map((handler) => handler.username)
        .toSet();
    final previousSelectedHandler = _selectedHandler;
    if (_selectedHandler != null && !eligibleUsernames.contains(_selectedHandler)) {
      _selectedHandler = null;
    }
    _logHandlerDebug('TicketDetail.syncSelectedHandler', {
      'ticketId': _ticket.id,
      'department': _selectedDepartmentName().trim(),
      'previousSelectedHandler': previousSelectedHandler,
      'selectedHandler': _selectedHandler,
      'eligibleUsernames': eligibleUsernames.toList(),
    });
  }

  void _syncSelectedStatusWithDepartment() {
    final availableStatuses =
        _availableStatusesForTicketDepartment(_selectedDepartmentName());
    final allowedStatuses = availableStatuses.map((status) => status.key).toSet();
    if (!allowedStatuses.contains(_selectedStatus)) {
      final defaultStatus = availableStatuses.firstWhere(
        (status) => status.isDefault,
        orElse: () => availableStatuses.first,
      );
      _selectedStatus = defaultStatus.key;
    }
  }

  Future<void> _loadHandlersForDepartment(String departmentName) async {
    final normalizedDepartment = departmentName.trim();
    if (normalizedDepartment.isEmpty) {
      _logHandlerDebug('TicketDetail.loadHandlers.skipped', {
        'ticketId': _ticket.id,
        'department': normalizedDepartment,
        'reason': 'empty department',
      });
      return;
    }
    try {
      final users = await ref
          .read(chatApiServiceProvider)
          .fetchHelpdeskUsers(department: normalizedDepartment);
      final apiHandlers = users
          .where((user) => user.isActive && user.role != 'Viewer')
          .map(
            (user) => HelpdeskManagedUser(
              username: user.username,
              role: HelpdeskRole.fromString(user.role),
              department: user.department,
              departments: user.allDepartments,
            ),
          )
          .toList();
      final fallbackHandlers = widget.handlers.where((handler) {
        if (handler.role == HelpdeskRole.viewer) return false;
        return handler.allDepartments
            .map((department) => department.trim())
            .contains(normalizedDepartment);
      }).map((handler) => HelpdeskManagedUser(
            username: handler.username,
            role: handler.role,
            department: handler.department,
            departments: handler.departments,
          ))
          .toList();
      final mergedHandlers = <HelpdeskManagedUser>[...apiHandlers];
      for (final handler in fallbackHandlers) {
        if (!mergedHandlers.any((entry) => entry.username == handler.username)) {
          mergedHandlers.add(handler);
        }
      }
      _logHandlerDebug('TicketDetail.loadHandlers.resolved', {
        'ticketId': _ticket.id,
        'department': normalizedDepartment,
        'requestPath': '/helpdesk/users?department=<ticket department>',
        'apiUsersCount': users.length,
        'apiUsers': users,
        'apiHandlersCount': apiHandlers.length,
        'apiHandlers': apiHandlers,
        'fallbackHandlersCount': fallbackHandlers.length,
        'fallbackHandlers': fallbackHandlers,
        'mergedHandlersCount': mergedHandlers.length,
        'mergedHandlers': mergedHandlers,
      });
      if (!mounted) return;
      setState(() {
        _allHandlers = mergedHandlers;
        _syncSelectedHandlerWithDepartment();
      });
    } catch (error) {
      _logHandlerDebug('TicketDetail.loadHandlers.failed', {
        'ticketId': _ticket.id,
        'department': normalizedDepartment,
        'requestPath': '/helpdesk/users?department=<ticket department>',
        'error': error,
        'fallbackHandlersCount': widget.handlers.length,
        'fallbackHandlers': widget.handlers,
      });
    }
  }

  @override
  void dispose() {
    _noteCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    final api = ref.read(chatApiServiceProvider);
    final ticketId = int.tryParse(_ticket.id) ?? 0;
    await Future.wait([
      _loadHistory(api, ticketId),
      _loadHandlerHistory(api, ticketId),
      _loadNotes(api, ticketId),
      _loadHandlersForDepartment(_selectedDepartmentName()),
    ]);
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

  Future<void> _saveDepartmentTransfer() async {
    final selectedDepartment = _findSelectedDepartment();
    if (selectedDepartment == null) {
      setState(() => _departmentError = 'יש לבחור מחלקה');
      return;
    }
    if (selectedDepartment.name == _ticket.department) {
      setState(() => _departmentError = 'יש לבחור מחלקה אחרת');
      return;
    }

    setState(() {
      _savingDepartment = true;
      _departmentError = null;
    });
    try {
      await ref
          .read(helpdeskProvider.notifier)
          .transferTicketDepartment(int.parse(_ticket.id), selectedDepartment.id);
      if (!mounted) return;
      showTopToast(context, 'הקריאה הועברה בהצלחה');
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _departmentError = e.toString());
    } finally {
      if (mounted) setState(() => _savingDepartment = false);
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
    if (!_canAddNote) return;
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
        _history != null ? _totalDurationLabel(_history!, widget.departments, _ticket.department) : '';
    final eligibleHandlers = _eligibleHandlersForDepartment();
    final availableStatuses = _availableStatusesForTicketDepartment();

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
                _StatusChip(
                  status: _selectedStatus,
                  departmentName: _ticket.department,
                ),
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
                          departmentName: _ticket.department,
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

                  if (_canTransferDepartment) ...[
                    const SizedBox(height: 16),
                    const Divider(),
                    const SizedBox(height: 8),
                    Row(children: [
                      const Icon(Icons.swap_horiz, size: 20),
                      const SizedBox(width: 6),
                      Text('העברה למחלקה אחרת',
                          style: theme.textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.bold)),
                    ]),
                    const SizedBox(height: 8),
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Expanded(
                        child: DropdownButtonFormField<int>(
                          initialValue: _selectedDepartmentId,
                          decoration: const InputDecoration(
                              labelText: 'מחלקת יעד',
                              border: OutlineInputBorder()),
                          hint: const Text('בחר מחלקה'),
                          items: widget.departments
                              .map((department) => DropdownMenuItem<int>(
                                    value: department.id,
                                    child: Text(department.name),
                                  ))
                              .toList(),
                          onChanged: (value) {
                            setState(() {
                              _selectedDepartmentId = value;
                              _syncSelectedHandlerWithDepartment();
                              _syncSelectedStatusWithDepartment();
                              _handlerError = null;
                            });
                            if (value != null) {
                              unawaited(
                                _loadHandlersForDepartment(_selectedDepartmentName()),
                              );
                            }
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      ElevatedButton.icon(
                        onPressed: _savingDepartment ? null : _saveDepartmentTransfer,
                        icon: _savingDepartment
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2))
                            : const Icon(Icons.save),
                        label: const Text('העבר'),
                      ),
                    ]),
                    if (_departmentError != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(_departmentError!,
                            style: TextStyle(
                                color: theme.colorScheme.error, fontSize: 12)),
                      ),
                  ],

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
                          initialValue: _selectedHandler,
                          decoration: const InputDecoration(
                              labelText: 'בחר מטפל',
                              border: OutlineInputBorder()),
                          items: [
                            const DropdownMenuItem<String?>(
                                value: null, child: Text('— ללא מטפל —')),
                            ...eligibleHandlers.map((h) =>
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
                          initialValue: _selectedStatus,
                          decoration: const InputDecoration(
                              labelText: 'סטטוס',
                              border: OutlineInputBorder()),
                          items: availableStatuses
                              .map((statusEntry) => DropdownMenuItem(
                                  value: statusEntry.key,
                                  child: Text(
                                    _statusLabel(
                                      widget.departments,
                                      _ticket.department,
                                      statusEntry.key,
                                    ),
                                  )))
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

                  if (_canAddNote) ...[
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
                  ],

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
  final String departmentName;

  const _HistoryEntry({
    required this.entry,
    required this.displayName,
    required this.departmentName,
  });

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
                    _MiniStatusChip(
                      status: entry.oldStatus!,
                       departmentName: departmentName,
                    ),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 4),
                      child: Icon(Icons.arrow_forward, size: 14),
                    ),
                    _MiniStatusChip(
                      status: entry.newStatus,
                      departmentName: departmentName,
                    ),
                  ] else ...[
                    const Padding(
                      padding: EdgeInsets.only(left: 4),
                      child: Icon(Icons.add_circle_outline, size: 14),
                    ),
                    const SizedBox(width: 4),
                    _MiniStatusChip(
                      status: entry.newStatus,
                      departmentName: departmentName,
                    ),
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

class _MiniStatusChip extends ConsumerWidget {
  final String status;
  final String departmentName;

  const _MiniStatusChip({
    required this.status,
    required this.departmentName,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final departments = ref.watch(helpdeskProvider).departments;
    final color = _statusColor(departments, departmentName, status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withAlpha(25),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withAlpha(80)),
      ),
      child: Text(_statusLabel(departments, departmentName, status),
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
            _AttachmentRow(url: note.attachmentUrl!),
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
    final resolvedUrl = resolveToAbsoluteUrl(url);
    if (!await openAuthenticatedFileExternally(context, resolvedUrl)) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('לא ניתן לפתוח את הקובץ')),
        );
      }
    }
  }

  void _showImagePreview(BuildContext context) {
    final size = MediaQuery.of(context).size;
    showDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierColor: Colors.black87,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: EdgeInsets.zero,
        child: Stack(
          children: [
            GestureDetector(
              onTap: () => Navigator.of(ctx).pop(),
              child: const SizedBox.expand(),
            ),
            Center(
              child: InteractiveViewer(
                maxScale: 4,
                child: AuthenticatedNetworkImage(
                  url: url,
                  width: size.width,
                  height: size.height * 0.85,
                  fit: BoxFit.contain,
                ),
              ),
            ),
            Positioned(
              top: MediaQuery.of(ctx).padding.top + 4,
              right: 4,
              child: IconButton(
                onPressed: () => Navigator.of(ctx).pop(),
                icon: const Icon(Icons.close, color: Colors.white, size: 28),
                style: IconButton.styleFrom(backgroundColor: Colors.black38),
              ),
            ),
          ],
        ),
      ),
    );
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
                    onTap: () => _showImagePreview(context),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: AuthenticatedNetworkImage(
                        url: url,
                        height: 160,
                        width: double.infinity,
                        fit: BoxFit.cover,
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

// ---------------------------------------------------------------------------
// Department Settings Screen (Admin only)
// ---------------------------------------------------------------------------

class _DepartmentSettingsScreen extends ConsumerStatefulWidget {
  final String currentUser;
  const _DepartmentSettingsScreen({required this.currentUser});

  @override
  ConsumerState<_DepartmentSettingsScreen> createState() =>
      _DepartmentSettingsScreenState();
}

class _DepartmentSettingsScreenState
    extends ConsumerState<_DepartmentSettingsScreen> {
  List<HelpdeskDepartmentEntry> _departments = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _fetchDepartments();
  }

  Future<void> _fetchDepartments() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = ref.read(chatApiServiceProvider);
      final depts = await api.getAllHelpdeskDepartments();
      setState(() {
        _departments = depts;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _showAddEditDialog({HelpdeskDepartmentEntry? existing}) async {
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final sortCtrl = TextEditingController(
        text: existing != null ? existing.sortOrder.toString() : '0');
    String status = existing?.status ?? 'active';
    final legacyIcon = (existing?.icon ?? '').trim();
    final hasKnownExistingIcon = _departmentIconDataFromKey(legacyIcon) != null;
    String selectedIconKey = hasKnownExistingIcon
        ? legacyIcon
        : _kHelpdeskDepartmentIconOptions.first.key;
    // Working copy of ticket form fields — mutable during the dialog session.
    List<HelpdeskTicketStatus> ticketStatuses =
        List<HelpdeskTicketStatus>.from(
      existing?.ticketStatuses.isNotEmpty == true
          ? existing!.ticketStatuses
          : _defaultDepartmentTicketStatuses(),
    );
    List<HelpdeskTicketFormField> ticketForm =
        List<HelpdeskTicketFormField>.from(existing?.ticketForm ?? []);
    HelpdeskInitialFormConfig initialForm =
        existing?.initialForm ?? const HelpdeskInitialFormConfig();

    // --- Permissions: pre-load before showing the dialog ---
    final api = ref.read(chatApiServiceProvider);
    List<DepartmentUserPermission> deptPermissions = <DepartmentUserPermission>[];
    List<HelpdeskUser> allHelpdeskUsers = <HelpdeskUser>[];
    try {
      final results = await Future.wait<dynamic>([
        api.fetchHelpdeskUsers(),
        if (existing != null)
          api.getDepartmentPermissions(widget.currentUser, existing.id)
        else
          Future<List<DepartmentUserPermission>>.value([]),
      ]);
      allHelpdeskUsers = (results[0] as List<HelpdeskUser>?) ?? [];
      deptPermissions = List<DepartmentUserPermission>.from(
          (results[1] as List<DepartmentUserPermission>?) ?? []);
    } catch (_) {
      // Non-fatal: show dialog without pre-loaded permissions
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => Directionality(
          textDirection: ui.TextDirection.rtl,
          child: AlertDialog(
            title: Text(existing == null ? 'הוסף מחלקה' : 'ערוך מחלקה'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextField(
                    controller: nameCtrl,
                    textDirection: ui.TextDirection.rtl,
                    decoration: const InputDecoration(
                        labelText: 'שם מחלקה *',
                        border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: selectedIconKey,
                    decoration: const InputDecoration(
                        labelText: 'אייקון מחלקה', border: OutlineInputBorder()),
                    items: [
                      ..._kHelpdeskDepartmentIconOptions.map((option) =>
                          DropdownMenuItem(
                            value: option.key,
                            child: Row(
                              children: [
                                Icon(option.icon),
                                const SizedBox(width: 8),
                                Expanded(child: Text(option.label)),
                              ],
                            ),
                          )),
                    ],
                    onChanged: (value) {
                      if (value == null) return;
                      setSt(() => selectedIconKey = value);
                    },
                  ),
                  if (legacyIcon.isNotEmpty && !hasKnownExistingIcon)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        'סמל קודם לא נתמך עוד: $legacyIcon',
                        style: TextStyle(color: Theme.of(ctx).colorScheme.error),
                      ),
                    ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: sortCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                        labelText: 'סדר מיון',
                        border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: status,
                    decoration: const InputDecoration(
                        labelText: 'סטטוס', border: OutlineInputBorder()),
                    items: const [
                      DropdownMenuItem(value: 'active', child: Text('פעיל')),
                      DropdownMenuItem(
                          value: 'inactive', child: Text('לא פעיל')),
                    ],
                    onChanged: (v) => setSt(() => status = v ?? 'active'),
                  ),
                  const SizedBox(height: 16),
                  const Divider(),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('סטטוסי קריאה',
                          style: TextStyle(fontWeight: FontWeight.bold)),
                      TextButton.icon(
                        onPressed: () async {
                          final added =
                              await _showTicketStatusEditorDialog(ctx, null);
                          if (added != null) {
                            setSt(() {
                              final updated = [...ticketStatuses, added]
                                ..sort((a, b) =>
                                    a.sortOrder.compareTo(b.sortOrder));
                              if (!updated.any((status) => status.isDefault)) {
                                updated[0] = updated[0].copyWith(isDefault: true);
                              }
                              ticketStatuses = updated;
                            });
                          }
                        },
                        icon: const Icon(Icons.add, size: 18),
                        label: const Text('הוסף סטטוס'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  if (ticketStatuses.isEmpty)
                    const Text('אין סטטוסים מוגדרים',
                        style: TextStyle(fontSize: 13, color: Colors.grey))
                  else
                    ...ticketStatuses.asMap().entries.map((entry) {
                      final index = entry.key;
                      final ticketStatus = entry.value;
                      return Card(
                        margin: const EdgeInsets.only(bottom: 6),
                        child: ListTile(
                          dense: true,
                          leading: CircleAvatar(
                            radius: 10,
                            backgroundColor:
                                _statusColorFromHex(ticketStatus.colorHex),
                          ),
                          title: Text(ticketStatus.label),
                          subtitle: Text(
                            '${ticketStatus.key}'
                            '${ticketStatus.isDefault ? ' • ברירת מחדל' : ''}'
                            '${ticketStatus.isTerminal ? ' • סופי' : ''}',
                          ),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                icon: const Icon(Icons.edit, size: 18),
                                onPressed: () async {
                                  final edited =
                                      await _showTicketStatusEditorDialog(
                                    ctx,
                                    ticketStatus,
                                  );
                                  if (edited != null) {
                                    setSt(() {
                                      final updated =
                                          List<HelpdeskTicketStatus>.from(
                                              ticketStatuses);
                                      updated[index] = edited;
                                      if (edited.isDefault) {
                                        for (var i = 0;
                                            i < updated.length;
                                            i++) {
                                          if (i != index) {
                                            updated[i] = updated[i]
                                                .copyWith(isDefault: false);
                                          }
                                        }
                                      }
                                      if (!updated.any(
                                          (status) => status.isDefault)) {
                                        updated[0] = updated[0]
                                            .copyWith(isDefault: true);
                                      }
                                      ticketStatuses = updated
                                        ..sort((a, b) => a.sortOrder
                                            .compareTo(b.sortOrder));
                                    });
                                  }
                                },
                              ),
                              IconButton(
                                icon: const Icon(Icons.delete_outline,
                                    size: 18, color: Colors.red),
                                onPressed: ticketStatuses.length <= 1
                                    ? null
                                    : () => setSt(() {
                                          final updated = [
                                            ...ticketStatuses
                                          ]..removeAt(index);
                                          if (!updated.any(
                                              (status) => status.isDefault)) {
                                            updated[0] = updated[0]
                                                .copyWith(isDefault: true);
                                          }
                                          ticketStatuses = updated;
                                        }),
                              ),
                            ],
                          ),
                        ),
                      );
                    }),
                  const SizedBox(height: 16),
                  const Divider(),
                  const Align(
                    alignment: Alignment.centerRight,
                    child: Text('שדות טופס ראשוני',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                  ),
                  SwitchListTile(
                    value: initialForm.showTitle,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('הצג כותרת'),
                    onChanged: (v) =>
                        setSt(() => initialForm = initialForm.copyWith(showTitle: v)),
                  ),
                  SwitchListTile(
                    value: initialForm.showDescription,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('הצג תיאור'),
                    onChanged: (v) => setSt(
                        () => initialForm = initialForm.copyWith(showDescription: v)),
                  ),
                  SwitchListTile(
                    value: initialForm.showLocation,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('הצג מיקום'),
                    onChanged: (v) => setSt(
                        () => initialForm = initialForm.copyWith(showLocation: v)),
                  ),
                  SwitchListTile(
                    value: initialForm.showPhone,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('הצג טלפון'),
                    onChanged: (v) =>
                        setSt(() => initialForm = initialForm.copyWith(showPhone: v)),
                  ),
                  SwitchListTile(
                    value: initialForm.showPriority,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('הצג דחיפות'),
                    onChanged: (v) => setSt(
                        () => initialForm = initialForm.copyWith(showPriority: v)),
                  ),
                  SwitchListTile(
                    value: initialForm.showAttachment,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('הצג צרוף קובץ'),
                    onChanged: (v) => setSt(
                        () => initialForm = initialForm.copyWith(showAttachment: v)),
                  ),
                  const SizedBox(height: 12),
                  // Ticket form fields section
                  const Divider(),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('שדות טופס קריאה',
                          style: TextStyle(fontWeight: FontWeight.bold)),
                      TextButton.icon(
                        onPressed: () async {
                          final added =
                              await _showFormFieldEditorDialog(ctx, null);
                          if (added != null) {
                            setSt(() => ticketForm = [...ticketForm, added]);
                          }
                        },
                        icon: const Icon(Icons.add, size: 18),
                        label: const Text('הוסף שדה'),
                      ),
                    ],
                  ),
                  if (ticketForm.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: Text('אין שדות מוגדרים',
                          style: TextStyle(
                              fontSize: 13, color: Colors.grey)),
                    )
                  else
                    ...ticketForm.asMap().entries.map((entry) {
                      final i = entry.key;
                      final f = entry.value;
                      return Card(
                        margin: const EdgeInsets.only(bottom: 6),
                        child: ListTile(
                          dense: true,
                          title: Text(f.label,
                              style: const TextStyle(
                                  fontWeight: FontWeight.w600,
                                  fontSize: 13)),
                          subtitle: Text(
                              '${_fieldTypeLabel(f.type)}${f.required ? " (חובה)" : ""}',
                              style: const TextStyle(fontSize: 11)),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                icon: const Icon(Icons.edit, size: 18),
                                onPressed: () async {
                                  final edited =
                                      await _showFormFieldEditorDialog(
                                          ctx, f);
                                  if (edited != null) {
                                    setSt(() {
                                      final updated =
                                          List<HelpdeskTicketFormField>.from(
                                              ticketForm);
                                      updated[i] = edited;
                                      ticketForm = updated;
                                    });
                                  }
                                },
                              ),
                              IconButton(
                                icon: const Icon(Icons.delete_outline,
                                    size: 18, color: Colors.red),
                                onPressed: () => setSt(() {
                                  ticketForm = [...ticketForm]..removeAt(i);
                                }),
                              ),
                            ],
                          ),
                        ),
                      );
                    }),
                  // --- Permissions section ---
                  const SizedBox(height: 12),
                  const Divider(),
                  const Align(
                    alignment: Alignment.centerRight,
                    child: Text(
                      'הרשאות משתמשים ותפקידים',
                      style: TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'השאר ריק כדי לאפשר גישה לכלל המשתמשים. בבחירת משתמשים, רק המשתמשים הנבחרים יוכלו לראות ולנהל קריאות במחלקה זו לפי התפקיד שהוגדר.',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  const SizedBox(height: 8),
                  Builder(builder: (bctx) {
                    final addedIds = deptPermissions
                        .map((p) => p.userId.toLowerCase())
                        .toSet();
                    final hasAvailableUsers = allHelpdeskUsers.any((u) =>
                        !addedIds.contains(u.username.toLowerCase()));
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        OutlinedButton.icon(
                          onPressed: !hasAvailableUsers
                              ? null
                              : () async {
                                  final selectedUser =
                                      await _showPermissionUserPickerDialog(
                                    ctx,
                                    allUsers: allHelpdeskUsers,
                                    excludedUserIds: addedIds,
                                  );
                                  if (selectedUser == null) return;
                                  setSt(() {
                                    final exists = deptPermissions.any((p) =>
                                        p.userId.toLowerCase() ==
                                        selectedUser.username.toLowerCase());
                                    if (!exists) {
                                      deptPermissions = [
                                        ...deptPermissions,
                                        DepartmentUserPermission(
                                            userId: selectedUser.username,
                                            role: 'Editor'),
                                      ];
                                    }
                                  });
                                },
                          icon: const Icon(Icons.person_add_alt_1),
                          label: const Text('בחר משתמש להוספה'),
                        ),
                        if (!hasAvailableUsers)
                          const Padding(
                            padding: EdgeInsets.only(top: 6),
                            child: Text(
                              'כל המשתמשים כבר נוספו',
                              style: TextStyle(fontSize: 12, color: Colors.grey),
                            ),
                          ),
                      ],
                    );
                  }),
                  ...deptPermissions.asMap().entries.map((entry) {
                    final idx = entry.key;
                    final perm = entry.value;
                    return Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              perm.userId,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 8),
                          DropdownButton<String>(
                            value: perm.role,
                            isDense: true,
                            items: const [
                              DropdownMenuItem(
                                  value: 'Admin',
                                  child: Text('Admin')),
                              DropdownMenuItem(
                                  value: 'Editor',
                                  child: Text('Editor')),
                              DropdownMenuItem(
                                  value: 'Viewer',
                                  child: Text('Viewer')),
                            ],
                            onChanged: (v) => setSt(() {
                              final updated =
                                  List<DepartmentUserPermission>.from(
                                      deptPermissions);
                              updated[idx] = perm.copyWith(role: v);
                              deptPermissions = updated;
                            }),
                          ),
                          IconButton(
                            icon: const Icon(
                                Icons.remove_circle_outline,
                                color: Colors.red,
                                size: 20),
                            onPressed: () => setSt(() {
                              deptPermissions = [...deptPermissions]
                                ..removeAt(idx);
                            }),
                          ),
                        ],
                      ),
                    );
                  }),
                ],
              ),
            ),
            actions: [
              TextButton(
                  onPressed: () => Navigator.of(ctx).pop(false),
                  child: const Text('ביטול')),
              ElevatedButton(
                  onPressed: () => Navigator.of(ctx).pop(true),
                  child: const Text('שמור')),
            ],
          ),
        ),
      ),
    );

    if (confirmed != true) return;
    if (nameCtrl.text.trim().isEmpty) {
      showTopToast(context, 'יש להזין שם מחלקה');
      return;
    }

    try {
      if (existing == null) {
        final newId = await api.addHelpdeskDepartment(
          widget.currentUser,
          name: nameCtrl.text.trim(),
          icon: selectedIconKey,
          status: status,
          sortOrder: int.tryParse(sortCtrl.text.trim()) ?? 0,
          ticketStatuses: ticketStatuses,
          ticketForm: ticketForm,
          initialForm: initialForm,
        );
        if (newId > 0) {
          await api.setDepartmentPermissions(
              widget.currentUser, newId, deptPermissions);
        }
        if (mounted) showTopToast(context, 'המחלקה נוספה בהצלחה');
      } else {
        await api.updateHelpdeskDepartment(
          widget.currentUser,
          existing.id,
          name: nameCtrl.text.trim(),
          icon: selectedIconKey,
          status: status,
          sortOrder: int.tryParse(sortCtrl.text.trim()) ?? existing.sortOrder,
          ticketStatuses: ticketStatuses,
          ticketForm: ticketForm,
          initialForm: initialForm,
        );
        await api.setDepartmentPermissions(
            widget.currentUser, existing.id, deptPermissions);
        if (mounted) showTopToast(context, 'המחלקה עודכנה בהצלחה');
      }
      await _fetchDepartments();
      // Refresh main helpdesk so department picker updates
      ref.read(helpdeskProvider.notifier).loadTickets(force: true);
    } catch (e) {
      if (mounted) {
        showTopToast(context, 'שגיאה: ${e.toString()}',
            backgroundColor: Theme.of(context).colorScheme.error);
      }
    }
  }

  Future<HelpdeskUser?> _showPermissionUserPickerDialog(
    BuildContext context, {
    required List<HelpdeskUser> allUsers,
    required Set<String> excludedUserIds,
  }) async {
    final searchCtrl = TextEditingController();
    try {
      return await showDialog<HelpdeskUser>(
        context: context,
        builder: (ctx) => StatefulBuilder(
          builder: (ctx, setSt) {
            final query = searchCtrl.text.trim().toLowerCase();
            final users = allUsers
                .where((u) => !excludedUserIds.contains(u.username.toLowerCase()))
                .where((u) {
              if (query.isEmpty) return true;
              return u.username.toLowerCase().contains(query) ||
                  (u.fullName ?? '').toLowerCase().contains(query);
            }).toList();
            return Directionality(
              textDirection: ui.TextDirection.rtl,
              child: AlertDialog(
                title: const Text('בחירת משתמש'),
                content: SizedBox(
                  width: 420,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      TextField(
                        controller: searchCtrl,
                        decoration: const InputDecoration(
                          labelText: 'חיפוש משתמש',
                          prefixIcon: Icon(Icons.search),
                          border: OutlineInputBorder(),
                          isDense: true,
                        ),
                        onChanged: (_) => setSt(() {}),
                      ),
                      const SizedBox(height: 10),
                      Flexible(
                        child: users.isEmpty
                            ? const Center(
                                child: Text(
                                  'לא נמצאו משתמשים',
                                  style: TextStyle(color: Colors.grey),
                                ),
                              )
                            : ListView.builder(
                                shrinkWrap: true,
                                itemCount: users.length,
                                itemBuilder: (context, index) {
                                  final user = users[index];
                                  final fullName = (user.fullName ?? '').trim();
                                  return ListTile(
                                    dense: true,
                                    title: Text(user.username),
                                    subtitle:
                                        fullName.isNotEmpty ? Text(fullName) : null,
                                    onTap: () => Navigator.of(ctx).pop(user),
                                  );
                                },
                              ),
                      ),
                    ],
                  ),
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(ctx).pop(),
                    child: const Text('סגור'),
                  ),
                ],
              ),
            );
          },
        ),
      );
    } finally {
      searchCtrl.dispose();
    }
  }

  String _fieldTypeLabel(HelpdeskTicketFormFieldType type) {
    switch (type) {
      case HelpdeskTicketFormFieldType.input:
        return 'שדה קלט';
      case HelpdeskTicketFormFieldType.textarea:
        return 'שטח טקסט';
      case HelpdeskTicketFormFieldType.radio:
        return 'בחירה יחידה (radio)';
      case HelpdeskTicketFormFieldType.select:
        return 'רשימה עם חיפוש';
    }
  }

  String _normalizeTicketStatusKey(String value) {
    final normalized = value
        .trim()
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9]+'), '_')
        .replaceAll(RegExp(r'_+'), '_')
        .replaceAll(RegExp(r'^_+|_+$'), '');
    return normalized.length > 64 ? normalized.substring(0, 64) : normalized;
  }

  Future<HelpdeskTicketStatus?> _showTicketStatusEditorDialog(
    BuildContext ctx,
    HelpdeskTicketStatus? existing,
  ) async {
    final keyCtrl = TextEditingController(text: existing?.key ?? '');
    final labelCtrl = TextEditingController(text: existing?.label ?? '');
    final colorCtrl =
        TextEditingController(text: existing?.colorHex ?? '#757575');
    final sortOrderCtrl = TextEditingController(
      text: (existing?.sortOrder ?? 0).toString(),
    );
    bool isTerminal = existing?.isTerminal ?? false;
    bool isDefault = existing?.isDefault ?? false;

    final result = await showDialog<HelpdeskTicketStatus>(
      context: ctx,
      builder: (_) => StatefulBuilder(
        builder: (ctx2, setSt2) => Directionality(
          textDirection: ui.TextDirection.rtl,
          child: AlertDialog(
            title: Text(existing == null ? 'הוסף סטטוס' : 'ערוך סטטוס'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: labelCtrl,
                    decoration: const InputDecoration(
                      labelText: 'שם תצוגה *',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: keyCtrl,
                    decoration: const InputDecoration(
                      labelText: 'מזהה סטטוס (אנגלית) *',
                      hintText: 'awaiting_parts',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: colorCtrl,
                    decoration: const InputDecoration(
                      labelText: 'צבע HEX',
                      hintText: '#757575',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: sortOrderCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'סדר מיון',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  SwitchListTile(
                    value: isDefault,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('סטטוס ברירת מחדל'),
                    onChanged: (value) => setSt2(() => isDefault = value),
                  ),
                  SwitchListTile(
                    value: isTerminal,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('סטטוס סופי'),
                    onChanged: (value) => setSt2(() => isTerminal = value),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx2).pop(),
                child: const Text('ביטול'),
              ),
              ElevatedButton(
                onPressed: () {
                  final label = labelCtrl.text.trim();
                  final key = _normalizeTicketStatusKey(keyCtrl.text);
                  final color = colorCtrl.text.trim().isEmpty
                      ? '#757575'
                      : colorCtrl.text.trim();
                  if (label.isEmpty || key.isEmpty) {
                    return;
                  }
                  Navigator.of(ctx2).pop(
                    HelpdeskTicketStatus(
                      id: existing?.id ?? 0,
                      key: key,
                      label: label,
                      colorHex: color,
                      sortOrder: int.tryParse(sortOrderCtrl.text.trim()) ?? 0,
                      isTerminal: isTerminal,
                      isDefault: isDefault,
                    ),
                  );
                },
                child: const Text('אישור'),
              ),
            ],
          ),
        ),
      ),
    );

    keyCtrl.dispose();
    labelCtrl.dispose();
    colorCtrl.dispose();
    sortOrderCtrl.dispose();
    return result;
  }

  /// Opens a dialog to add or edit a [HelpdeskTicketFormField].
  Future<HelpdeskTicketFormField?> _showFormFieldEditorDialog(
      BuildContext ctx, HelpdeskTicketFormField? existing) async {
    HelpdeskTicketFormFieldType fieldType =
        existing?.type ?? HelpdeskTicketFormFieldType.input;
    HelpdeskTicketFormInputType inputType =
        existing?.inputType ?? HelpdeskTicketFormInputType.text;
    final labelCtrl = TextEditingController(text: existing?.label ?? '');
    final idCtrl = TextEditingController(text: existing?.id ?? '');
    final placeholderCtrl =
        TextEditingController(text: existing?.placeholder ?? '');
    final initialValueCtrl =
        TextEditingController(text: existing?.initialValue ?? '');
    bool isRequired = existing?.required ?? false;
    // Options for radio/select (one per line stored as list)
    final optionsCtrl = TextEditingController(
        text: (existing?.options ?? []).join('\n'));

    final result = await showDialog<HelpdeskTicketFormField>(
      context: ctx,
      builder: (_) => StatefulBuilder(
        builder: (ctx2, setSt2) => Directionality(
          textDirection: ui.TextDirection.rtl,
          child: AlertDialog(
            title: Text(existing == null ? 'הוסף שדה' : 'ערוך שדה'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: labelCtrl,
                    textDirection: ui.TextDirection.rtl,
                    decoration: const InputDecoration(
                        labelText: 'תווית שדה *',
                        border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: idCtrl,
                    decoration: const InputDecoration(
                        labelText: 'מזהה שדה (אנגלית)',
                        hintText: 'field_id',
                        border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 10),
                  DropdownButtonFormField<HelpdeskTicketFormFieldType>(
                    initialValue: fieldType,
                    decoration: const InputDecoration(
                        labelText: 'סוג שדה',
                        border: OutlineInputBorder()),
                    items: HelpdeskTicketFormFieldType.values
                        .map((t) => DropdownMenuItem(
                              value: t,
                              child: Text(_fieldTypeLabel(t)),
                            ))
                        .toList(),
                    onChanged: (v) =>
                        setSt2(() => fieldType = v ?? fieldType),
                  ),
                  if (fieldType == HelpdeskTicketFormFieldType.input) ...[
                    const SizedBox(height: 10),
                    DropdownButtonFormField<HelpdeskTicketFormInputType>(
                      initialValue: inputType,
                      decoration: const InputDecoration(
                          labelText: 'סוג קלט',
                          border: OutlineInputBorder()),
                      items: const [
                        DropdownMenuItem(
                            value: HelpdeskTicketFormInputType.text,
                            child: Text('טקסט')),
                        DropdownMenuItem(
                            value: HelpdeskTicketFormInputType.tel,
                            child: Text('טלפון')),
                        DropdownMenuItem(
                            value: HelpdeskTicketFormInputType.number,
                            child: Text('מספר')),
                      ],
                      onChanged: (v) =>
                          setSt2(() => inputType = v ?? inputType),
                    ),
                  ],
                  if (fieldType == HelpdeskTicketFormFieldType.radio ||
                      fieldType == HelpdeskTicketFormFieldType.select) ...[
                    const SizedBox(height: 10),
                    TextField(
                      controller: optionsCtrl,
                      textDirection: ui.TextDirection.rtl,
                      maxLines: 5,
                      decoration: const InputDecoration(
                        labelText: 'אפשרויות (שורה לכל אפשרות)',
                        border: OutlineInputBorder(),
                        hintText: 'אפשרות 1\nאפשרות 2',
                      ),
                    ),
                  ],
                  const SizedBox(height: 10),
                  TextField(
                    controller: initialValueCtrl,
                    textDirection: ui.TextDirection.rtl,
                    decoration: const InputDecoration(
                        labelText: 'ערך ברירת מחדל',
                        border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: placeholderCtrl,
                    textDirection: ui.TextDirection.rtl,
                    decoration: const InputDecoration(
                        labelText: 'טקסט placeholder',
                        border: OutlineInputBorder()),
                  ),
                  const SizedBox(height: 10),
                  CheckboxListTile(
                    value: isRequired,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('שדה חובה'),
                    onChanged: (v) =>
                        setSt2(() => isRequired = v ?? false),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                  onPressed: () => Navigator.of(ctx2).pop(),
                  child: const Text('ביטול')),
              ElevatedButton(
                onPressed: () {
                  final label = labelCtrl.text.trim();
                  if (label.isEmpty) return;
                  // Derive id from label if not provided
                  final String rawId;
                  if (idCtrl.text.trim().isNotEmpty) {
                    rawId = idCtrl.text.trim();
                  } else {
                    final transformed = label
                        .toLowerCase()
                        .replaceAll(RegExp(r'[^a-zA-Z0-9]'), '_')
                        .replaceAll(RegExp(r'_+'), '_')
                        .replaceAll(RegExp(r'^_+|_+$'), '');
                    rawId = transformed.length > 64
                        ? transformed.substring(0, 64)
                        : transformed;
                  }
                  final options = optionsCtrl.text
                      .split('\n')
                      .map((o) => o.trim())
                      .where((o) => o.isNotEmpty)
                      .toList();
                  final field = HelpdeskTicketFormField(
                    id: rawId,
                    label: label,
                    type: fieldType,
                    inputType: inputType,
                    required: isRequired,
                    initialValue: initialValueCtrl.text.trim(),
                    placeholder: placeholderCtrl.text.trim(),
                    options: options,
                  );
                  Navigator.of(ctx2).pop(field);
                },
                child: const Text('אישור'),
              ),
            ],
          ),
        ),
      ),
    );

    labelCtrl.dispose();
    idCtrl.dispose();
    placeholderCtrl.dispose();
    initialValueCtrl.dispose();
    optionsCtrl.dispose();
    return result;
  }

  Future<void> _deleteDepartment(HelpdeskDepartmentEntry dept) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => Directionality(
        textDirection: ui.TextDirection.rtl,
        child: AlertDialog(
          title: const Text('מחיקת מחלקה'),
          content: Text(
              'למחוק את המחלקה "${dept.name}"?\n\nלא ניתן למחוק מחלקה שיש לה קריאות פתוחות.'),
          actions: [
            TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('ביטול')),
            ElevatedButton(
              style:
                  ElevatedButton.styleFrom(backgroundColor: Colors.red),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('מחק',
                  style: TextStyle(color: Colors.white)),
            ),
          ],
        ),
      ),
    );

    if (confirmed != true) return;

    final api = ref.read(chatApiServiceProvider);
    try {
      await api.deleteHelpdeskDepartment(widget.currentUser, dept.id);
      if (mounted) showTopToast(context, 'המחלקה נמחקה');
      await _fetchDepartments();
      ref.read(helpdeskProvider.notifier).loadTickets(force: true);
    } catch (e) {
      if (mounted) {
        showTopToast(context, 'שגיאה: ${e.toString()}',
            backgroundColor: Theme.of(context).colorScheme.error);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('הגדרות מחלקות'),
          actions: [
            IconButton(
              icon: const Icon(Icons.refresh),
              onPressed: _fetchDepartments,
            ),
          ],
        ),
        floatingActionButton: FloatingActionButton(
          onPressed: _showAddEditDialog,
          child: const Icon(Icons.add),
        ),
        body: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!,
                            style:
                                TextStyle(color: theme.colorScheme.error)),
                        const SizedBox(height: 12),
                        ElevatedButton(
                            onPressed: _fetchDepartments,
                            child: const Text('נסה שוב')),
                      ],
                    ),
                  )
                : _departments.isEmpty
                    ? const Center(child: Text('אין מחלקות'))
                    : ListView.separated(
                        padding: const EdgeInsets.all(12),
                        itemCount: _departments.length,
                        separatorBuilder: (_, __) =>
                            const Divider(height: 1),
                        itemBuilder: (context, i) {
                          final dept = _departments[i];
                          return ListTile(
                            leading: _buildDepartmentIcon(dept.icon, size: 24),
                            title: Text(dept.name,
                                style: const TextStyle(
                                    fontWeight: FontWeight.bold)),
                            subtitle: Text(
                              'סדר: ${dept.sortOrder} • סטטוסים: ${dept.ticketStatuses.isNotEmpty ? dept.ticketStatuses.length : _defaultDepartmentTicketStatuses().length}',
                            ),
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Container(
                                  padding: const EdgeInsets.symmetric(
                                      horizontal: 8, vertical: 3),
                                  decoration: BoxDecoration(
                                    color: dept.isActive
                                        ? Colors.green.shade100
                                        : Colors.grey.shade200,
                                    borderRadius:
                                        BorderRadius.circular(12),
                                  ),
                                  child: Text(
                                    dept.isActive ? 'פעיל' : 'לא פעיל',
                                    style: TextStyle(
                                      fontSize: 11,
                                      color: dept.isActive
                                          ? Colors.green.shade800
                                          : Colors.grey.shade700,
                                    ),
                                  ),
                                ),
                                IconButton(
                                  icon: const Icon(Icons.edit,
                                      size: 20),
                                  onPressed: () =>
                                      _showAddEditDialog(existing: dept),
                                ),
                                IconButton(
                                  icon: const Icon(Icons.delete_outline,
                                      size: 20, color: Colors.red),
                                  onPressed: () =>
                                      _deleteDepartment(dept),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
      ),
    );
  }
}
