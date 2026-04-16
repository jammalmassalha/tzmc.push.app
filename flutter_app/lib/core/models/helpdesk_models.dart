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
  final HelpdeskDepartment department;
  final String title;
  final String description;

  const HelpdeskTicketPayload({
    required this.department,
    required this.title,
    required this.description,
  });

  @override
  List<Object?> get props => [department, title, description];

  Map<String, dynamic> toJson() => {
        'department': department.label,
        'title': title,
        'description': description,
      };
}

/// Helpdesk ticket model
class HelpdeskTicket extends Equatable {
  final int id;
  final String creatorUsername;
  final String department;
  final String title;
  final String description;
  final HelpdeskStatus status;
  final String? handlerUsername;
  final DateTime createdAt;
  final DateTime updatedAt;

  const HelpdeskTicket({
    required this.id,
    required this.creatorUsername,
    required this.department,
    required this.title,
    required this.description,
    required this.status,
    this.handlerUsername,
    required this.createdAt,
    required this.updatedAt,
  });

  @override
  List<Object?> get props => [
        id,
        creatorUsername,
        department,
        title,
        description,
        status,
        handlerUsername,
        createdAt,
        updatedAt,
      ];

  factory HelpdeskTicket.fromJson(Map<String, dynamic> json) {
    return HelpdeskTicket(
      id: json['id'] as int,
      creatorUsername: json['creatorUsername'] as String? ?? '',
      department: json['department'] as String? ?? '',
      title: json['title'] as String? ?? '',
      description: json['description'] as String? ?? '',
      status: HelpdeskStatus.fromString(json['status'] as String? ?? 'open'),
      handlerUsername: json['handlerUsername'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
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
      id: json['id'] as int,
      ticketId: json['ticketId'] as int,
      authorUsername: json['authorUsername'] as String? ?? '',
      noteText: json['noteText'] as String? ?? '',
      attachmentUrl: json['attachmentUrl'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }
}

/// Helpdesk status history entry
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
      id: json['id'] as int,
      ticketId: json['ticketId'] as int,
      oldStatus: json['old_status'] as String?,
      newStatus: json['new_status'] as String? ?? '',
      changedBy: json['changed_by'] as String? ?? '',
      createdAt: DateTime.parse(json['created_at'] as String),
    );
  }
}
