/// Helpdesk domain models
library;

import 'package:equatable/equatable.dart';

/// Helpdesk departments
enum HelpdeskDepartment {
  it('מערכות מידע'),
  maintenance('אחזקה');

  final String label;
  const HelpdeskDepartment(this.label);

  static HelpdeskDepartment fromString(String value) {
    switch (value) {
      case 'מערכות מידע':
        return HelpdeskDepartment.it;
      case 'אחזקה':
        return HelpdeskDepartment.maintenance;
      default:
        return HelpdeskDepartment.it;
    }
  }
}

/// Helpdesk ticket status
enum HelpdeskStatus {
  open,
  inProgress,
  resolved,
  closed;

  static HelpdeskStatus fromString(String value) {
    switch (value.toLowerCase()) {
      case 'open':
        return HelpdeskStatus.open;
      case 'in_progress':
        return HelpdeskStatus.inProgress;
      case 'resolved':
        return HelpdeskStatus.resolved;
      case 'closed':
        return HelpdeskStatus.closed;
      default:
        return HelpdeskStatus.open;
    }
  }

  String toApiValue() {
    switch (this) {
      case HelpdeskStatus.open:
        return 'open';
      case HelpdeskStatus.inProgress:
        return 'in_progress';
      case HelpdeskStatus.resolved:
        return 'resolved';
      case HelpdeskStatus.closed:
        return 'closed';
    }
  }
}

/// Helpdesk user role
enum HelpdeskRole {
  admin,
  editor;

  static HelpdeskRole fromString(String value) {
    switch (value.toLowerCase()) {
      case 'admin':
        return HelpdeskRole.admin;
      case 'editor':
        return HelpdeskRole.editor;
      default:
        return HelpdeskRole.editor;
    }
  }
}

/// Helpdesk ticket creation payload
class HelpdeskTicketPayload extends Equatable {
  final String subject;
  final String description;
  final String priority;
  final HelpdeskDepartment? department;
  final String? title;
  final String? location;
  final String? phone;
  final String? attachmentUrl;

  const HelpdeskTicketPayload({
    this.subject = '',
    this.description = '',
    this.priority = 'normal',
    this.department,
    this.title,
    this.location,
    this.phone,
    this.attachmentUrl,
  });

  @override
  List<Object?> get props => [subject, description, priority, department, title, location, phone, attachmentUrl];

  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{
      'title': title ?? subject,
      'subject': subject,
      'description': description,
      // Backend expects 'department' with Hebrew values (מערכות מידע, אחזקה)
      'department': department?.label ?? HelpdeskDepartment.it.label,
      'priority': priority,
    };
    if (location != null && location!.isNotEmpty) json['location'] = location;
    if (phone != null && phone!.isNotEmpty) json['phone'] = phone;
    if (attachmentUrl != null && attachmentUrl!.isNotEmpty) json['attachmentUrl'] = attachmentUrl;
    return json;
  }
}

/// Helpdesk comment model (for UI)
class HelpdeskComment extends Equatable {
  final String id;
  final String author;
  final String content;
  final DateTime createdAt;

  const HelpdeskComment({
    required this.id,
    required this.author,
    required this.content,
    required this.createdAt,
  });

  @override
  List<Object?> get props => [id, author, content, createdAt];

  factory HelpdeskComment.fromJson(Map<String, dynamic> json) {
    return HelpdeskComment(
      id: (json['id'] ?? '').toString(),
      author: json['author'] as String? ?? json['authorUsername'] as String? ?? '',
      content: json['content'] as String? ?? json['noteText'] as String? ?? '',
      createdAt: json['createdAt'] is String 
          ? DateTime.parse(json['createdAt'] as String)
          : DateTime.now(),
    );
  }
}

/// Helpdesk status history (for UI)
class HelpdeskStatusHistory extends Equatable {
  final int id;
  final String? oldStatus;
  final String newStatus;
  final String changedBy;
  final DateTime createdAt;

  const HelpdeskStatusHistory({
    required this.id,
    this.oldStatus,
    required this.newStatus,
    required this.changedBy,
    required this.createdAt,
  });

  @override
  List<Object?> get props => [id, oldStatus, newStatus, changedBy, createdAt];

  factory HelpdeskStatusHistory.fromJson(Map<String, dynamic> json) {
    return HelpdeskStatusHistory(
      id: (json['id'] as num?)?.toInt() ?? 0,
      oldStatus: (json['oldStatus'] ?? json['old_status']) as String?,
      newStatus: (json['newStatus'] ?? json['new_status']) as String? ?? '',
      changedBy: (json['changedBy'] ?? json['changed_by']) as String? ?? '',
      createdAt: DateTime.tryParse(
              (json['createdAt'] ?? json['created_at']) as String? ?? '') ??
          DateTime.now(),
    );
  }
}

/// Helpdesk ticket model
class HelpdeskTicket extends Equatable {
  final String id;
  final String creatorUsername;
  final String department;
  final String subject;
  final String description;
  final String status;
  final String priority;
  final String? handlerUsername;
  final String? location;
  final String? phone;
  final String? attachmentUrl;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<HelpdeskComment> comments;

  const HelpdeskTicket({
    required this.id,
    required this.creatorUsername,
    required this.department,
    required this.subject,
    required this.description,
    required this.status,
    this.priority = 'normal',
    this.handlerUsername,
    this.location,
    this.phone,
    this.attachmentUrl,
    required this.createdAt,
    required this.updatedAt,
    this.comments = const [],
  });

  // Alias for subject
  String get title => subject;

  @override
  List<Object?> get props => [
        id,
        creatorUsername,
        department,
        subject,
        description,
        status,
        priority,
        handlerUsername,
        location,
        phone,
        attachmentUrl,
        createdAt,
        updatedAt,
        comments,
      ];

  factory HelpdeskTicket.fromJson(Map<String, dynamic> json) {
    final commentsJson = json['comments'] as List? ?? json['notes'] as List? ?? [];
    
    return HelpdeskTicket(
      id: (json['id'] ?? '').toString(),
      creatorUsername: json['creatorUsername'] as String? ?? json['creator'] as String? ?? '',
      department: json['department'] as String? ?? json['category'] as String? ?? '',
      subject: json['subject'] as String? ?? json['title'] as String? ?? '',
      description: json['description'] as String? ?? '',
      status: json['status'] as String? ?? 'open',
      priority: json['priority'] as String? ?? 'normal',
      handlerUsername: json['handlerUsername'] as String? ?? json['assignee'] as String?,
      location: json['location'] as String?,
      phone: json['phone'] as String?,
      attachmentUrl: json['attachmentUrl'] as String?,
      createdAt: json['createdAt'] is String 
          ? DateTime.parse(json['createdAt'] as String)
          : DateTime.now(),
      updatedAt: json['updatedAt'] is String 
          ? DateTime.parse(json['updatedAt'] as String)
          : DateTime.now(),
      comments: commentsJson.map((e) => HelpdeskComment.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }
}

/// Helpdesk managed user
class HelpdeskManagedUser extends Equatable {
  final String username;
  final HelpdeskRole role;
  final String department;

  const HelpdeskManagedUser({
    required this.username,
    required this.role,
    required this.department,
  });

  @override
  List<Object?> get props => [username, role, department];

  factory HelpdeskManagedUser.fromJson(Map<String, dynamic> json) {
    return HelpdeskManagedUser(
      username: json['username'] as String? ?? '',
      role: HelpdeskRole.fromString(json['role'] as String? ?? 'editor'),
      department: json['department'] as String? ?? '',
    );
  }
}

/// My role in helpdesk
class HelpdeskMyRole extends Equatable {
  final HelpdeskRole role;
  final String department;

  const HelpdeskMyRole({
    required this.role,
    required this.department,
  });

  @override
  List<Object?> get props => [role, department];

  factory HelpdeskMyRole.fromJson(Map<String, dynamic> json) {
    return HelpdeskMyRole(
      role: HelpdeskRole.fromString(json['role'] as String? ?? 'editor'),
      department: json['department'] as String? ?? '',
    );
  }
}

/// Helpdesk dashboard data
class HelpdeskDashboard extends Equatable {
  final List<HelpdeskTicket> ongoing;
  final List<HelpdeskTicket> past;
  final List<HelpdeskTicket> assigned;
  final HelpdeskMyRole? myRole;
  final List<HelpdeskTicket>? editorTickets;
  final List<HelpdeskManagedUser>? handlers;

  const HelpdeskDashboard({
    required this.ongoing,
    required this.past,
    required this.assigned,
    this.myRole,
    this.editorTickets,
    this.handlers,
  });

  /// Get all tickets combined
  List<HelpdeskTicket> get tickets => [...ongoing, ...past, ...assigned];

  @override
  List<Object?> get props => [ongoing, past, assigned, myRole, editorTickets, handlers];

  factory HelpdeskDashboard.fromJson(Map<String, dynamic> json) {
    return HelpdeskDashboard(
      ongoing: (json['ongoing'] as List? ?? []).map((e) => HelpdeskTicket.fromJson(e as Map<String, dynamic>)).toList(),
      past: (json['past'] as List? ?? []).map((e) => HelpdeskTicket.fromJson(e as Map<String, dynamic>)).toList(),
      assigned: (json['assigned'] as List? ?? []).map((e) => HelpdeskTicket.fromJson(e as Map<String, dynamic>)).toList(),
      myRole: json['myRole'] != null ? HelpdeskMyRole.fromJson(json['myRole'] as Map<String, dynamic>) : null,
      editorTickets:
          (json['editorTickets'] as List?)?.map((e) => HelpdeskTicket.fromJson(e as Map<String, dynamic>)).toList(),
      handlers:
          (json['handlers'] as List?)?.map((e) => HelpdeskManagedUser.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }
}

/// Helpdesk note
class HelpdeskNote extends Equatable {
  final int id;
  final int ticketId;
  final String authorUsername;
  final String noteText;
  final String? attachmentUrl;
  final DateTime createdAt;

  const HelpdeskNote({
    required this.id,
    required this.ticketId,
    required this.authorUsername,
    required this.noteText,
    this.attachmentUrl,
    required this.createdAt,
  });

  @override
  List<Object?> get props => [id, ticketId, authorUsername, noteText, attachmentUrl, createdAt];

  factory HelpdeskNote.fromJson(Map<String, dynamic> json) {
    return HelpdeskNote(
      id: (json['id'] as num?)?.toInt() ?? 0,
      ticketId: (json['ticketId'] as num?)?.toInt() ?? 0,
      authorUsername: json['authorUsername'] as String? ?? '',
      noteText: json['noteText'] as String? ?? '',
      attachmentUrl: json['attachmentUrl'] as String?,
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.now(),
    );
  }
}

/// Helpdesk status history entry (API response)
class HelpdeskStatusHistoryEntry extends Equatable {
  final int id;
  final int ticketId;
  final String? oldStatus;
  final String newStatus;
  final String changedBy;
  final DateTime createdAt;

  const HelpdeskStatusHistoryEntry({
    required this.id,
    required this.ticketId,
    this.oldStatus,
    required this.newStatus,
    required this.changedBy,
    required this.createdAt,
  });

  @override
  List<Object?> get props => [id, ticketId, oldStatus, newStatus, changedBy, createdAt];

  factory HelpdeskStatusHistoryEntry.fromJson(Map<String, dynamic> json) {
    return HelpdeskStatusHistoryEntry(
      id: (json['id'] as num?)?.toInt() ?? 0,
      ticketId: (json['ticketId'] as num?)?.toInt() ?? 0,
      oldStatus: (json['oldStatus'] ?? json['old_status']) as String?,
      newStatus: (json['newStatus'] ?? json['new_status']) as String? ?? '',
      changedBy: (json['changedBy'] ?? json['changed_by']) as String? ?? '',
      createdAt: DateTime.tryParse(
              (json['createdAt'] ?? json['created_at']) as String? ?? '') ??
          DateTime.now(),
    );
  }
}
