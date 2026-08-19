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
    String? loadError;

    List<HelpdeskUser> users = <HelpdeskUser>[];
    try {
      users = (await api.fetchHelpdeskUsers()).toList()
        ..sort(
          (a, b) =>
              a.username.toLowerCase().compareTo(b.username.toLowerCase()),
        );
    } catch (e) {
      loadError = _normalizeError(e);
    }

    List<HelpdeskDepartment> departments = <HelpdeskDepartment>[];
    try {
      departments = (await api.getActiveHelpdeskDepartments())
          .map(HelpdeskDepartment.fromEntry)
          .toList()
        ..sort((a, b) => a.name.compareTo(b.name));
    } catch (e) {
      loadError ??= _normalizeError(e);
    }

    if (!mounted) return;
    setState(() {
      _users = users;
      _departments = departments;
      _error = loadError;
      _isLoading = false;
    });
  }

  Future<void> _openUserForm({HelpdeskUser? existing}) async {
    if (_departments.isEmpty) {
      showTopToast(context, 'לא נמצאו מחלקות פעילות/מוגדרות');
      return;
    }

    await showDialog<void>(
      context: context,
      builder: (ctx) => HelpdeskUserFormDialog(
        departments: _departments,
        users: _users,
        existing: existing,
        onSubmit: (formData) async {
          final api = ref.read(chatApiServiceProvider);
          if (existing == null) {
            await api.createHelpdeskUser(
              username: formData.username,
              role: formData.role,
              department: formData.department,
              status: formData.status,
            );
          } else {
            await api.updateHelpdeskUser(
              existing.id,
              username: formData.username,
              role: formData.role,
              department: formData.department,
              status: formData.status,
            );
          }
          await _loadData(showLoader: false);
          if (!mounted) return;
          showTopToast(
            context,
            existing == null ? 'המשתמש נוסף בהצלחה' : 'המשתמש עודכן בהצלחה',
          );
        },
      ),
    );
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
  final List<HelpdeskUser> users;
  final HelpdeskUser? existing;
  final Future<void> Function(HelpdeskUserFormData data) onSubmit;

  const HelpdeskUserFormDialog({
    required this.departments,
    required this.users,
    required this.onSubmit,
    this.existing,
    super.key,
  });

  @override
  ConsumerState<HelpdeskUserFormDialog> createState() =>
      _HelpdeskUserFormDialogState();
}

class _HelpdeskUserFormDialogState
    extends ConsumerState<HelpdeskUserFormDialog> {
  final GlobalKey<FormState> _formKey = GlobalKey<FormState>();
  final TextEditingController _searchController = TextEditingController();
  String _query = '';
  Contact? _selectedContact;
  late String _selectedUsername;
  late String _role;
  late String _department;
  late bool _isActive;
  bool _isSubmitting = false;

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    _role = widget.existing?.role ?? 'Editor';
    final departmentNames = widget.departments.map((d) => d.name).toSet();
    final existingDepartment = widget.existing?.department;
    _department = existingDepartment != null &&
            departmentNames.contains(existingDepartment)
        ? existingDepartment
        : widget.departments.first.name;
    _isActive = widget.existing?.isActive ?? true;
    _selectedUsername = widget.existing?.username ?? '';

    _searchController.addListener(() {
      setState(() => _query = _searchController.text.trim().toLowerCase());
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _selectContact(Contact contact) {
    final departmentNames = widget.departments.map((d) => d.name).toSet();
    String? matched;
    if (contact.info != null && contact.info!.isNotEmpty) {
      final infoLower = contact.info!.toLowerCase();
      for (final dept in widget.departments) {
        if (infoLower.contains(dept.name.toLowerCase())) {
          matched = dept.name;
          break;
        }
      }
    }
    setState(() {
      _selectedContact = contact;
      _selectedUsername = contact.username;
      _query = '';
      _searchController.clear();
      if (matched != null && departmentNames.contains(matched)) {
        _department = matched;
      }
    });
  }

  void _clearContact() {
    setState(() {
      _selectedContact = null;
      _selectedUsername = '';
      _query = '';
      _searchController.clear();
    });
  }

  List<Contact> _filteredContacts() {
    final contacts = ref.watch(chatStoreProvider).contacts;
    final me = ref.watch(chatStoreProvider.notifier).currentUser;
    return contacts.values.where((c) {
      if (me != null && c.username.trim().toLowerCase() == me) return false;
      if (c.status == 0) return false;
      if (_query.isEmpty) return true;
      final info = (c.info ?? '').toLowerCase();
      final phone = (c.phone ?? '').toLowerCase();
      return c.displayName.toLowerCase().contains(_query) ||
          c.username.toLowerCase().contains(_query) ||
          info.contains(_query) ||
          phone.contains(_query);
    }).toList()
      ..sort((a, b) => a.displayName.compareTo(b.displayName));
  }

  Future<void> _submit() async {
    final formState = _formKey.currentState;
    if (formState == null || !formState.validate()) return;
    final username = _selectedUsername.trim();
    if (username.isEmpty) return;

    setState(() => _isSubmitting = true);
    try {
      await widget.onSubmit(
        HelpdeskUserFormData(
          username: username,
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
        title: Text(_isEdit ? 'ערוך משתמש מוקד' : 'הוסף משתמש מוקד'),
        content: Form(
          key: _formKey,
          child: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  if (_isEdit) ...<Widget>[
                    // Edit mode: show username as read-only label
                    InputDecorator(
                      decoration: const InputDecoration(
                        labelText: 'שם משתמש',
                        border: OutlineInputBorder(),
                      ),
                      child: Text(
                        _selectedUsername,
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                    ),
                  ] else if (_selectedContact != null) ...<Widget>[
                    // Contact selected: show tile + clear button
                    _SelectedContactTile(
                      contact: _selectedContact!,
                      onClear: _isSubmitting ? null : _clearContact,
                    ),
                  ] else ...<Widget>[
                    // Contact search picker
                    TextField(
                      controller: _searchController,
                      textDirection: ui.TextDirection.rtl,
                      enabled: !_isSubmitting,
                      decoration: const InputDecoration(
                        hintText: 'חיפוש איש קשר לפי שם, מחלקה, טלפון',
                        prefixIcon: Icon(Icons.search),
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                    const SizedBox(height: 4),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 220),
                      child: Builder(
                        builder: (context) {
                          final filtered = _filteredContacts();
                          if (filtered.isEmpty) {
                            return const Padding(
                              padding: EdgeInsets.symmetric(vertical: 16),
                              child: Center(
                                child: Text('לא נמצאו אנשי קשר'),
                              ),
                            );
                          }
                          return ListView.builder(
                            shrinkWrap: true,
                            itemCount: filtered.length,
                            itemBuilder: (context, index) {
                              final contact = filtered[index];
                              return _ContactPickerTile(
                                contact: contact,
                                onTap: _isSubmitting
                                    ? null
                                    : () => _selectContact(contact),
                              );
                            },
                          );
                        },
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
        ),
        actions: <Widget>[
          TextButton(
            onPressed: _isSubmitting ? null : () => Navigator.of(context).pop(),
            child: const Text('ביטול'),
          ),
          ElevatedButton(
            onPressed: (_isSubmitting ||
                    (!_isEdit && _selectedContact == null))
                ? null
                : _submit,
            child: _isSubmitting
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(_isEdit ? 'שמור' : 'הוסף'),
          ),
        ],
      ),
    );
  }
}

class _SelectedContactTile extends StatelessWidget {
  final Contact contact;
  final VoidCallback? onClear;

  const _SelectedContactTile({required this.contact, this.onClear});

  @override
  Widget build(BuildContext context) {
    final initial = contact.displayName.isNotEmpty
        ? contact.displayName[0].toUpperCase()
        : '?';
    final fallback = CircleAvatar(
      backgroundColor: AppColors.primary,
      radius: 20,
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

    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: AppColors.primary.withOpacity(0.4)),
        borderRadius: BorderRadius.circular(8),
        color: AppColors.primary.withOpacity(0.05),
      ),
      child: ListTile(
        leading: avatar,
        title: Text(
          contact.displayName,
          style: const TextStyle(fontWeight: FontWeight.w600),
        ),
        subtitle: contact.info != null && contact.info!.isNotEmpty
            ? Text(
                contact.info!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              )
            : null,
        trailing: onClear != null
            ? IconButton(
                icon: const Icon(Icons.close),
                tooltip: 'שנה משתמש',
                onPressed: onClear,
              )
            : null,
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
