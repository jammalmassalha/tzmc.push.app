library;

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/models/chat_models.dart';
import '../../../core/models/helpdesk_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/utils/toast_utils.dart';
import '../../../shared/theme/app_theme.dart';
import '../../../shared/widgets/authenticated_image.dart';

class HelpdeskUserManagementScreen extends ConsumerStatefulWidget {
  final String currentUser;

  const HelpdeskUserManagementScreen({
    required this.currentUser,
    super.key,
  });

  @override
  ConsumerState<HelpdeskUserManagementScreen> createState() =>
      _HelpdeskUserManagementScreenState();
}

class _HelpdeskUserManagementScreenState
    extends ConsumerState<HelpdeskUserManagementScreen> {
  final Set<int> _busyUserIds = <int>{};
  List<HelpdeskUser> _users = <HelpdeskUser>[];
  List<HelpdeskDepartment> _departments = <HelpdeskDepartment>[];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  String _normalizeError(Object error) {
    final raw = error.toString().replaceFirst('ApiException: ', '').trim();
    return raw.isNotEmpty ? raw : 'שגיאה בטעינת המשתמשים';
  }

  Future<void> _loadData({bool showLoader = true}) async {
    if (!mounted) return;
    setState(() {
      if (showLoader) {
        _isLoading = true;
      }
      _error = null;
    });

    final api = ref.read(chatApiServiceProvider);
    String? usersError;
    String? departmentsError;

    List<HelpdeskUser> users = <HelpdeskUser>[];
    try {
      final fetchedUsers = await api.fetchHelpdeskUsers();
      users = fetchedUsers.toList()
        ..sort(
          (a, b) =>
              a.username.toLowerCase().compareTo(b.username.toLowerCase()),
        );
    } catch (e) {
      debugPrint('Failed to load helpdesk users: $e');
      usersError = _normalizeError(e);
    }

    List<HelpdeskDepartment> departments = <HelpdeskDepartment>[];
    try {
      final entries = await api.getActiveHelpdeskDepartments();
      departments = entries
          .map(HelpdeskDepartment.fromEntry)
          .where((department) => department.name.trim().isNotEmpty)
          .toList()
        ..sort((a, b) => a.name.compareTo(b.name));
    } catch (e) {
      debugPrint('Failed to load helpdesk departments: $e');
      departmentsError = _normalizeError(e);
    }

    if (!mounted) return;
    setState(() {
      _users = users;
      _departments = departments;
      _error = usersError;
      _isLoading = false;
    });
    if (usersError == null && departmentsError != null && mounted) {
      showTopToast(
        context,
        departmentsError!,
        backgroundColor: Theme.of(context).colorScheme.error,
      );
    }
  }

  Future<void> _openUserForm({HelpdeskUser? existing}) async {
    if (_departments.isEmpty) {
      showTopToast(context, 'לא נמצאו מחלקות פעילות/מוגדרות');
      return;
    }

    if (existing == null) {
      // --- Add flow: single dialog with embedded contact picker ---
      final contacts = _availableContacts();
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => _HelpdeskUserDetailsDialog(
          contacts: contacts,
          departments: _departments,
          onSubmit: (formData) async {
            final api = ref.read(chatApiServiceProvider);
            await api.createHelpdeskUser(
              username: formData.username,
              role: formData.role,
              department: formData.department,
              status: formData.status,
            );
            await _loadData(showLoader: false);
            if (!mounted) return;
            showTopToast(context, 'המשתמש נוסף בהצלחה');
          },
        ),
      );
    } else {
      // --- Edit flow: single step ---
      await showDialog<void>(
        context: context,
        builder: (ctx) => HelpdeskUserFormDialog(
          departments: _departments,
          existing: existing,
          onSubmit: (formData) async {
            final api = ref.read(chatApiServiceProvider);
            await api.updateHelpdeskUser(
              existing.id,
              username: formData.username,
              role: formData.role,
              department: formData.department,
              status: formData.status,
            );
            await _loadData(showLoader: false);
            if (!mounted) return;
            showTopToast(context, 'המשתמש עודכן בהצלחה');
          },
        ),
      );
    }
  }

  List<Contact> _availableContacts() {
    final contacts = ref.read(chatStoreProvider).contacts;
    final me = ref.read(chatStoreProvider.notifier).currentUser;
    final existingUsernames =
        _users.map((u) => u.username.trim().toLowerCase()).toSet();
    return contacts.values.where((c) {
      if (me != null && c.username.trim().toLowerCase() == me) return false;
      if (c.status == 0) return false;
      if (existingUsernames.contains(c.username.trim().toLowerCase())) {
        return false;
      }
      return true;
    }).toList()
      ..sort((a, b) => a.displayName.compareTo(b.displayName));
  }

  Future<void> _toggleStatus(HelpdeskUser user) async {
    final newStatus = user.isActive ? 'Inactive' : 'Active';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => Directionality(
        textDirection: ui.TextDirection.rtl,
        child: AlertDialog(
          title: Text(user.isActive ? 'השבתת משתמש' : 'הפעלת משתמש'),
          content: Text(
            user.isActive
                ? 'האם להשבית את המשתמש "${user.username}"?'
                : 'האם להפעיל מחדש את המשתמש "${user.username}"?',
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('ביטול'),
            ),
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(user.isActive ? 'השבת' : 'הפעל'),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _busyUserIds.add(user.id));
    try {
      final api = ref.read(chatApiServiceProvider);
      await api.toggleHelpdeskUserStatus(user.id, newStatus);
      await _loadData(showLoader: false);
      if (!mounted) return;
      showTopToast(
        context,
        user.isActive ? 'המשתמש הושבת בהצלחה' : 'המשתמש הופעל בהצלחה',
      );
    } catch (e) {
      if (!mounted) return;
      showTopToast(
        context,
        e.toString().replaceFirst('ApiException: ', ''),
        backgroundColor: Theme.of(context).colorScheme.error,
      );
    } finally {
      if (mounted) {
        setState(() => _busyUserIds.remove(user.id));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('ניהול משתמשי מוקד'),
          actions: <Widget>[
            IconButton(
              tooltip: 'רענן',
              onPressed: _isLoading ? null : () => _loadData(),
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        floatingActionButton: FloatingActionButton.extended(
          onPressed: _isLoading ? null : () => _openUserForm(),
          icon: const Icon(Icons.person_add_alt_1_outlined),
          label: const Text('הוסף משתמש'),
        ),
        body: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.error_outline, color: Colors.red, size: 48),
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 12),
              ElevatedButton(
                onPressed: () => _loadData(),
                child: const Text('נסה שוב'),
              ),
            ],
          ),
        ),
      );
    }
    if (_users.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.people_alt_outlined, size: 56, color: Colors.grey),
              const SizedBox(height: 12),
              const Text(
                'אין משתמשי מוקד להצגה',
                style: TextStyle(color: Colors.grey),
              ),
              const SizedBox(height: 12),
              ElevatedButton.icon(
                onPressed: () => _openUserForm(),
                icon: const Icon(Icons.add),
                label: const Text('הוסף משתמש'),
              ),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: () => _loadData(),
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 88),
        itemCount: _users.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (context, index) {
          final user = _users[index];
          return _HelpdeskUserCard(
            user: user,
            isBusy: _busyUserIds.contains(user.id),
            onEdit: () => _openUserForm(existing: user),
            onToggleStatus: () => _toggleStatus(user),
          );
        },
      ),
    );
  }
}

String _helpdeskUserDisplayLabel({
  required String username,
  String? fullName,
  required String phoneNumber,
}) {
  final normalizedName = fullName?.trim() ?? '';
  final normalizedPhone = phoneNumber.trim();
  if (normalizedName.isNotEmpty) {
    return normalizedPhone.isNotEmpty
        ? '$normalizedName - $normalizedPhone'
        : normalizedName;
  }
  return normalizedPhone.isNotEmpty ? normalizedPhone : username;
}

class _HelpdeskUserCard extends ConsumerWidget {
  final HelpdeskUser user;
  final bool isBusy;
  final VoidCallback onEdit;
  final VoidCallback onToggleStatus;

  const _HelpdeskUserCard({
    required this.user,
    required this.isBusy,
    required this.onEdit,
    required this.onToggleStatus,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final createdAt = user.createdAt == null
        ? '—'
        : DateFormat('HH:mm, d.M.yyyy').format(user.createdAt!);
    final contact = ref.watch(chatStoreProvider).contacts[user.username];
    final fullName = user.fullName?.trim().isNotEmpty == true
        ? user.fullName!.trim()
        : contact?.displayName ?? '';
    final title = _helpdeskUserDisplayLabel(
      username: user.username,
      fullName: fullName,
      phoneNumber: user.phoneNumber,
    );
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        title,
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.bold,
                            ),
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: <Widget>[
                          _InfoChip(
                            label: user.role,
                            isPrimary: user.role == 'Admin',
                          ),
                          _InfoChip(label: user.status, isSuccess: user.isActive),
                          _InfoChip(label: user.department),
                        ],
                      ),
                    ],
                  ),
                ),
                if (isBusy)
                  const Padding(
                    padding: EdgeInsetsDirectional.only(start: 8),
                    child: SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              'נוצר: $createdAt',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                OutlinedButton.icon(
                  onPressed: isBusy ? null : onEdit,
                  icon: const Icon(Icons.edit_outlined),
                  label: const Text('ערוך'),
                ),
                OutlinedButton.icon(
                  onPressed: isBusy ? null : onToggleStatus,
                  icon: Icon(
                    user.isActive
                        ? Icons.block_outlined
                        : Icons.check_circle_outline,
                  ),
                  label: Text(user.isActive ? 'השבת' : 'הפעל'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _InfoChip extends StatelessWidget {
  final String label;
  final bool isPrimary;
  final bool isSuccess;

  const _InfoChip({
    required this.label,
    this.isPrimary = false,
    this.isSuccess = false,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final backgroundColor = isPrimary
        ? scheme.primaryContainer
        : isSuccess
            ? Colors.green.shade50
            : Colors.grey.shade200;
    final foregroundColor = isPrimary
        ? scheme.onPrimaryContainer
        : isSuccess
            ? Colors.green.shade800
            : Colors.black87;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: backgroundColor,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: foregroundColor,
          fontWeight: FontWeight.w600,
          fontSize: 12,
        ),
      ),
    );
  }
}

class HelpdeskUserFormData {
  final String username;
  final String role;
  final String department;
  final String status;

  const HelpdeskUserFormData({
    required this.username,
    required this.role,
    required this.department,
    required this.status,
  });
}

class HelpdeskUserFormDialog extends ConsumerStatefulWidget {
  final List<HelpdeskDepartment> departments;
  final HelpdeskUser existing;
  final Future<void> Function(HelpdeskUserFormData data) onSubmit;

  const HelpdeskUserFormDialog({
    required this.departments,
    required this.existing,
    required this.onSubmit,
    super.key,
  });

  @override
  ConsumerState<HelpdeskUserFormDialog> createState() =>
      _HelpdeskUserFormDialogState();
}

class _HelpdeskUserFormDialogState
    extends ConsumerState<HelpdeskUserFormDialog> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  late String _role;
  late String _department;
  late bool _isActive;
  bool _isSubmitting = false;

  @override
  void initState() {
    super.initState();
    _role = widget.existing.role;
    final departmentNames = widget.departments.map((d) => d.name).toSet();
    final existingDepartment = widget.existing.department;
    _department = departmentNames.contains(existingDepartment)
        ? existingDepartment
        : widget.departments.first.name;
    _isActive = widget.existing.isActive;
  }

  Future<void> _submit() async {
    final formState = _formKey.currentState;
    if (formState == null || !formState.validate()) return;

    setState(() => _isSubmitting = true);
    try {
      await widget.onSubmit(
        HelpdeskUserFormData(
          username: widget.existing.username,
          role: _role,
          department: _department,
          status: _isActive ? 'Active' : 'Inactive',
        ),
      );
      if (!mounted) return;
      Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      showTopToast(
        context,
        e.toString().replaceFirst('ApiException: ', ''),
        backgroundColor: Theme.of(context).colorScheme.error,
      );
      setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: AlertDialog(
        title: const Text('ערוך משתמש מוקד'),
        content: Form(
          key: _formKey,
          child: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  // Read-only username label
                  InputDecorator(
                    decoration: const InputDecoration(
                      labelText: 'שם משתמש',
                      border: OutlineInputBorder(),
                    ),
                    child: Text(
                      widget.existing.username,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    value: _role,
                    decoration: const InputDecoration(
                      labelText: 'תפקיד',
                      border: OutlineInputBorder(),
                    ),
                    items: const <DropdownMenuItem<String>>[
                      DropdownMenuItem(value: 'Admin', child: Text('Admin')),
                      DropdownMenuItem(value: 'Editor', child: Text('Editor')),
                    ],
                    onChanged: _isSubmitting
                        ? null
                        : (value) {
                            if (value == null) return;
                            setState(() => _role = value);
                          },
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    value: _department,
                    decoration: const InputDecoration(
                      labelText: 'מחלקה',
                      border: OutlineInputBorder(),
                    ),
                    items: widget.departments
                        .map(
                          (department) => DropdownMenuItem<String>(
                            value: department.name,
                            child: Text(department.name),
                          ),
                        )
                        .toList(),
                    onChanged: _isSubmitting
                        ? null
                        : (value) {
                            if (value == null) return;
                            setState(() => _department = value);
                          },
                  ),
                  const SizedBox(height: 12),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('משתמש פעיל'),
                    value: _isActive,
                    onChanged: _isSubmitting
                        ? null
                        : (value) => setState(() => _isActive = value),
                  ),
                ],
              ),
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: _isSubmitting ? null : () => Navigator.of(context).pop(),
            child: const Text('ביטול'),
          ),
          ElevatedButton(
            onPressed: _isSubmitting ? null : _submit,
            child: _isSubmitting
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('שמור'),
          ),
        ],
      ),
    );
  }
}

// Step-2 dialog for add-user flow: role, department, status.
class _HelpdeskUserDetailsDialog extends StatefulWidget {
  /// Used in the add flow (no pre-selected contact).
  final List<Contact>? contacts;

  /// Used in the edit flow (no contact picker needed).
  final Contact? contact;

  final List<HelpdeskDepartment> departments;
  final Future<void> Function(HelpdeskUserFormData data) onSubmit;

  const _HelpdeskUserDetailsDialog({
    this.contacts,
    this.contact,
    required this.departments,
    required this.onSubmit,
  });

  @override
  State<_HelpdeskUserDetailsDialog> createState() =>
      _HelpdeskUserDetailsDialogState();
}

class _HelpdeskUserDetailsDialogState
    extends State<_HelpdeskUserDetailsDialog> {
  late String _role;
  late String _department;
  bool _isActive = true;
  bool _isSubmitting = false;

  /// Only used in add flow.
  Contact? _selectedContact;
  final TextEditingController _contactTextController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _role = 'Editor';
    final departmentNames = widget.departments.map((d) => d.name).toSet();

    // Edit flow: pre-fill from existing contact.
    final preContact = widget.contact;
    if (preContact != null) {
      final info = (preContact.info ?? '').toLowerCase();
      String? matched;
      if (info.isNotEmpty) {
        for (final dept in widget.departments) {
          if (info.contains(dept.name.toLowerCase())) {
            matched = dept.name;
            break;
          }
        }
      }
      _department = (matched != null && departmentNames.contains(matched))
          ? matched
          : widget.departments.first.name;
    } else {
      _department = widget.departments.first.name;
    }
  }

  @override
  void dispose() {
    _contactTextController.dispose();
    super.dispose();
  }

  void _applyContactDepartment(Contact contact) {
    final departmentNames = widget.departments.map((d) => d.name).toSet();
    final info = (contact.info ?? '').toLowerCase();
    String? matched;
    if (info.isNotEmpty) {
      for (final dept in widget.departments) {
        if (info.contains(dept.name.toLowerCase())) {
          matched = dept.name;
          break;
        }
      }
    }
    if (matched != null && departmentNames.contains(matched)) {
      _department = matched;
    }
  }

  Future<void> _submit() async {
    final contact = widget.contact ?? _selectedContact;
    if (contact == null) return;
    setState(() => _isSubmitting = true);
    try {
      await widget.onSubmit(
        HelpdeskUserFormData(
          username: contact.username,
          role: _role,
          department: _department,
          status: _isActive ? 'Active' : 'Inactive',
        ),
      );
      if (!mounted) return;
      Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      showTopToast(
        context,
        e.toString().replaceFirst('ApiException: ', ''),
        backgroundColor: Theme.of(context).colorScheme.error,
      );
      setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isAddFlow = widget.contacts != null;
    final contact = widget.contact ?? _selectedContact;

    // Build subtitle for edit flow
    String? editSubtitle;
    if (!isAddFlow && contact != null) {
      final s = (contact.info ?? '').trim().isNotEmpty
          ? contact.info!.trim()
          : (contact.phone ?? '').trim().isNotEmpty
              ? contact.phone!.trim()
              : contact.username;
      editSubtitle = s;
    }

    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: AlertDialog(
        title: Text(isAddFlow ? 'הוסף משתמש מוקד' : 'ערוך משתמש מוקד'),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (isAddFlow) ...<Widget>[
                  // Tap-to-pick contact field (add flow)
                  TextFormField(
                    controller: _contactTextController,
                    readOnly: true,
                    decoration: InputDecoration(
                      labelText: 'איש קשר',
                      hintText: 'לחץ לבחירת איש קשר...',
                      prefixIcon: const Icon(Icons.person_search),
                      suffixIcon: _selectedContact != null
                          ? IconButton(
                              icon: const Icon(Icons.clear),
                              onPressed: _isSubmitting
                                  ? null
                                  : () {
                                      setState(() {
                                        _selectedContact = null;
                                        _contactTextController.clear();
                                      });
                                    },
                            )
                          : const Icon(Icons.arrow_drop_down),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    onTap: _isSubmitting
                        ? null
                        : () async {
                            final picked = await showDialog<Contact>(
                              context: context,
                              builder: (ctx) => _UserPickerDialog(
                                contacts: widget.contacts!,
                              ),
                            );
                            if (picked != null) {
                              setState(() {
                                _selectedContact = picked;
                                final dept = (picked.info ?? '').trim();
                                _contactTextController.text =
                                    dept.isNotEmpty
                                        ? '${picked.displayName} ($dept)'
                                        : picked.displayName;
                                _applyContactDepartment(picked);
                              });
                            }
                          },
                  ),
                ] else ...<Widget>[
                  // Read-only username label (edit flow)
                  InputDecorator(
                    decoration: const InputDecoration(
                      labelText: 'משתמש נבחר',
                      border: OutlineInputBorder(),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          contact!.displayName,
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        if (editSubtitle != null &&
                            editSubtitle.isNotEmpty) ...<Widget>[
                          const SizedBox(height: 2),
                          Text(
                            editSubtitle,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: _role,
                  decoration: const InputDecoration(
                    labelText: 'תפקיד',
                    border: OutlineInputBorder(),
                  ),
                  items: const <DropdownMenuItem<String>>[
                    DropdownMenuItem(value: 'Admin', child: Text('Admin')),
                    DropdownMenuItem(value: 'Editor', child: Text('Editor')),
                  ],
                  onChanged: _isSubmitting
                      ? null
                      : (value) {
                          if (value == null) return;
                          setState(() => _role = value);
                        },
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: _department,
                  decoration: const InputDecoration(
                    labelText: 'מחלקה',
                    border: OutlineInputBorder(),
                  ),
                  items: widget.departments
                      .map(
                        (department) => DropdownMenuItem<String>(
                          value: department.name,
                          child: Text(department.name),
                        ),
                      )
                      .toList(),
                  onChanged: _isSubmitting
                      ? null
                      : (value) {
                          if (value == null) return;
                          setState(() => _department = value);
                        },
                ),
                const SizedBox(height: 12),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('משתמש פעיל'),
                  value: _isActive,
                  onChanged: _isSubmitting
                      ? null
                      : (value) => setState(() => _isActive = value),
                ),
              ],
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed:
                _isSubmitting ? null : () => Navigator.of(context).pop(),
            child: const Text('ביטול'),
          ),
          ElevatedButton(
            onPressed: _isSubmitting || (isAddFlow && _selectedContact == null)
                ? null
                : _submit,
            child: _isSubmitting
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(isAddFlow ? 'הוסף' : 'שמור'),
          ),
        ],
      ),
    );
  }
}

class _UserPickerDialog extends StatefulWidget {
  final List<Contact> contacts;

  const _UserPickerDialog({required this.contacts});

  @override
  State<_UserPickerDialog> createState() => _UserPickerDialogState();
}

class _UserPickerDialogState extends State<_UserPickerDialog> {
  final TextEditingController _searchController = TextEditingController();
  List<Contact> _filteredContacts = [];

  @override
  void initState() {
    super.initState();
    _filteredContacts = widget.contacts;
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _onSearchChanged(String query) {
    final q = query.trim().toLowerCase();
    setState(() {
      if (q.isEmpty) {
        _filteredContacts = widget.contacts;
      } else {
        _filteredContacts = widget.contacts.where((contact) {
          final info = (contact.info ?? '').toLowerCase();
          final phone = (contact.phone ?? '').toLowerCase();
          return contact.displayName.toLowerCase().contains(q) ||
              contact.username.toLowerCase().contains(q) ||
              info.contains(q) ||
              phone.contains(q);
        }).toList();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: ui.TextDirection.rtl,
      child: Dialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        child: Container(
          width: 480,
          height: 540,
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: <Widget>[
                  const Text(
                    'בחירת איש קשר',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(null),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _searchController,
                textDirection: ui.TextDirection.rtl,
                autofocus: true,
                decoration: InputDecoration(
                  hintText: 'חיפוש איש קשר לפי שם, מחלקה, טלפון...',
                  prefixIcon: const Icon(Icons.search),
                  filled: true,
                  fillColor: Colors.grey.shade100,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide: BorderSide(color: Colors.grey.shade300),
                  ),
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                ),
                onChanged: _onSearchChanged,
              ),
              const SizedBox(height: 12),
              Expanded(
                child: _filteredContacts.isEmpty
                    ? const Center(child: Text('לא נמצאו תוצאות'))
                    : ListView.separated(
                        itemCount: _filteredContacts.length,
                        separatorBuilder: (_, __) =>
                            const Divider(height: 1),
                        itemBuilder: (context, index) {
                          final contact = _filteredContacts[index];
                          return _ContactPickerTile(
                            contact: contact,
                            onTap: () =>
                                Navigator.of(context).pop(contact),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ContactPickerTile extends StatelessWidget {
  final Contact contact;
  final VoidCallback? onTap;

  const _ContactPickerTile({required this.contact, this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final initial = contact.displayName.isNotEmpty
        ? contact.displayName[0].toUpperCase()
        : '?';
    final fallback = CircleAvatar(
      backgroundColor: AppColors.primary,
      child: Text(
        initial,
        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
      ),
    );
    final Widget avatar = (contact.upic != null && contact.upic!.isNotEmpty)
        ? AuthenticatedCircleAvatar(
            url: contact.upic,
            radius: 20,
            fallback: fallback,
          )
        : fallback;

    return ListTile(
      onTap: onTap,
      leading: avatar,
      title: Text(contact.displayName, style: theme.textTheme.bodyLarge),
      subtitle: contact.info != null && contact.info!.isNotEmpty
          ? Text(
              contact.info!,
              style: theme.textTheme.bodySmall,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            )
          : null,
    );
  }
}
