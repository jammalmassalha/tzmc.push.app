/// API payload models for request/response handling
///
/// These models mirror the TypeScript interfaces for API payloads
/// from the Angular frontend.
library;

import 'package:equatable/equatable.dart';
import 'chat_models.dart';

/// Reply payload for sending direct or group messages
class ReplyPayload extends Equatable {
  final String user;
  final String senderName;
  final String reply;
  final String? imageUrl;
  final String? fileUrl;
  final String originalSender;
  final String messageId;
  final List<String>? membersToNotify;
  final String? groupId;
  final String? groupName;
  final List<String>? groupMembers;
  final String? groupCreatedBy;
  final List<String>? groupAdmins;
  final int? groupUpdatedAt;
  final GroupType? groupType;
  final String? groupSenderName;
  final String? replyToMessageId;
  final String? replyToSender;
  final String? replyToSenderName;
  final String? replyToBody;
  final String? replyToImageUrl;
  final bool forwarded;
  final String? forwardedFrom;
  final String? forwardedFromName;

  const ReplyPayload({
    required this.user,
    required this.senderName,
    required this.reply,
    this.imageUrl,
    this.fileUrl,
    required this.originalSender,
    required this.messageId,
    this.membersToNotify,
    this.groupId,
    this.groupName,
    this.groupMembers,
    this.groupCreatedBy,
    this.groupAdmins,
    this.groupUpdatedAt,
    this.groupType,
    this.groupSenderName,
    this.replyToMessageId,
    this.replyToSender,
    this.replyToSenderName,
    this.replyToBody,
    this.replyToImageUrl,
    this.forwarded = false,
    this.forwardedFrom,
    this.forwardedFromName,
  });

  @override
  List<Object?> get props => [
        user,
        senderName,
        reply,
        imageUrl,
        fileUrl,
        originalSender,
        messageId,
        membersToNotify,
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        groupUpdatedAt,
        groupType,
        groupSenderName,
        replyToMessageId,
        replyToSender,
        replyToSenderName,
        replyToBody,
        replyToImageUrl,
        forwarded,
        forwardedFrom,
        forwardedFromName,
      ];

  Map<String, dynamic> toJson() => {
        'user': user,
        'senderName': senderName,
        'reply': reply,
        if (imageUrl != null) 'imageUrl': imageUrl,
        if (fileUrl != null) 'fileUrl': fileUrl,
        'originalSender': originalSender,
        'messageId': messageId,
        if (membersToNotify != null) 'membersToNotify': membersToNotify,
        if (groupId != null) 'groupId': groupId,
        if (groupName != null) 'groupName': groupName,
        if (groupMembers != null) 'groupMembers': groupMembers,
        if (groupCreatedBy != null) 'groupCreatedBy': groupCreatedBy,
        if (groupAdmins != null) 'groupAdmins': groupAdmins,
        if (groupUpdatedAt != null) 'groupUpdatedAt': groupUpdatedAt,
        if (groupType != null) 'groupType': groupType == GroupType.community ? 'community' : 'group',
        if (groupSenderName != null) 'groupSenderName': groupSenderName,
        if (replyToMessageId != null) 'replyToMessageId': replyToMessageId,
        if (replyToSender != null) 'replyToSender': replyToSender,
        if (replyToSenderName != null) 'replyToSenderName': replyToSenderName,
        if (replyToBody != null) 'replyToBody': replyToBody,
        if (replyToImageUrl != null) 'replyToImageUrl': replyToImageUrl,
        if (forwarded) 'forwarded': forwarded,
        if (forwardedFrom != null) 'forwardedFrom': forwardedFrom,
        if (forwardedFromName != null) 'forwardedFromName': forwardedFromName,
      };
}

/// Group update payload for creating/updating groups
class GroupUpdatePayload extends Equatable {
  final String groupId;
  final String groupName;
  final List<String> groupMembers;
  final String groupCreatedBy;
  final List<String>? groupAdmins;
  final String? actorUser;
  final int groupUpdatedAt;
  final GroupType groupType;
  final List<String> membersToNotify;

  const GroupUpdatePayload({
    required this.groupId,
    required this.groupName,
    required this.groupMembers,
    required this.groupCreatedBy,
    this.groupAdmins,
    this.actorUser,
    required this.groupUpdatedAt,
    required this.groupType,
    required this.membersToNotify,
  });

  @override
  List<Object?> get props => [
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        actorUser,
        groupUpdatedAt,
        groupType,
        membersToNotify,
      ];

  Map<String, dynamic> toJson() => {
        'groupId': groupId,
        'groupName': groupName,
        'groupMembers': groupMembers,
        'groupCreatedBy': groupCreatedBy,
        if (groupAdmins != null) 'groupAdmins': groupAdmins,
        if (actorUser != null) 'actorUser': actorUser,
        'groupUpdatedAt': groupUpdatedAt,
        'groupType': groupType == GroupType.community ? 'community' : 'group',
        'membersToNotify': membersToNotify,
      };
}

/// Reaction payload
class ReactionPayload extends Equatable {
  final String? groupId;
  final String? groupName;
  final List<String>? groupMembers;
  final String? groupCreatedBy;
  final List<String>? groupAdmins;
  final int? groupUpdatedAt;
  final GroupType? groupType;
  final String? targetUser;
  final String targetMessageId;
  final String emoji;
  final String reactor;
  final String reactorName;

  const ReactionPayload({
    this.groupId,
    this.groupName,
    this.groupMembers,
    this.groupCreatedBy,
    this.groupAdmins,
    this.groupUpdatedAt,
    this.groupType,
    this.targetUser,
    required this.targetMessageId,
    required this.emoji,
    required this.reactor,
    required this.reactorName,
  });

  @override
  List<Object?> get props => [
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        groupUpdatedAt,
        groupType,
        targetUser,
        targetMessageId,
        emoji,
        reactor,
        reactorName,
      ];

  Map<String, dynamic> toJson() => {
        if (groupId != null) 'groupId': groupId,
        if (groupName != null) 'groupName': groupName,
        if (groupMembers != null) 'groupMembers': groupMembers,
        if (groupCreatedBy != null) 'groupCreatedBy': groupCreatedBy,
        if (groupAdmins != null) 'groupAdmins': groupAdmins,
        if (groupUpdatedAt != null) 'groupUpdatedAt': groupUpdatedAt,
        if (groupType != null) 'groupType': groupType == GroupType.community ? 'community' : 'group',
        if (targetUser != null) 'targetUser': targetUser,
        'targetMessageId': targetMessageId,
        'emoji': emoji,
        'reactor': reactor,
        'reactorName': reactorName,
      };
}

/// Typing state payload
class TypingPayload extends Equatable {
  final String user;
  final bool isTyping;
  final String? targetUser;
  final String? chatId;
  final String? groupId;
  final String? groupName;
  final List<String>? groupMembers;

  const TypingPayload({
    required this.user,
    required this.isTyping,
    this.targetUser,
    this.chatId,
    this.groupId,
    this.groupName,
    this.groupMembers,
  });

  @override
  List<Object?> get props => [user, isTyping, targetUser, chatId, groupId, groupName, groupMembers];

  Map<String, dynamic> toJson() => {
        'user': user,
        'isTyping': isTyping,
        if (targetUser != null) 'targetUser': targetUser,
        if (chatId != null) 'chatId': chatId,
        if (groupId != null) 'groupId': groupId,
        if (groupName != null) 'groupName': groupName,
        if (groupMembers != null) 'groupMembers': groupMembers,
      };
}

/// Read receipt payload
class ReadReceiptPayload extends Equatable {
  final String reader;
  final String sender;
  final List<String> messageIds;
  final int readAt;

  const ReadReceiptPayload({
    required this.reader,
    required this.sender,
    required this.messageIds,
    required this.readAt,
  });

  @override
  List<Object?> get props => [reader, sender, messageIds, readAt];

  Map<String, dynamic> toJson() => {
        'reader': reader,
        'sender': sender,
        'messageIds': messageIds,
        'readAt': readAt,
      };
}

/// Edit message payload
class EditMessagePayload extends Equatable {
  final String sender;
  final String messageId;
  final String body;
  final int editedAt;
  final int? timestamp;
  final String? recipient;
  final List<String>? recipients;
  final String? groupId;
  final String? groupName;
  final List<String>? groupMembers;
  final String? groupCreatedBy;
  final List<String>? groupAdmins;
  final int? groupUpdatedAt;
  final GroupType? groupType;

  const EditMessagePayload({
    required this.sender,
    required this.messageId,
    required this.body,
    required this.editedAt,
    this.timestamp,
    this.recipient,
    this.recipients,
    this.groupId,
    this.groupName,
    this.groupMembers,
    this.groupCreatedBy,
    this.groupAdmins,
    this.groupUpdatedAt,
    this.groupType,
  });

  @override
  List<Object?> get props => [
        sender,
        messageId,
        body,
        editedAt,
        timestamp,
        recipient,
        recipients,
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        groupUpdatedAt,
        groupType,
      ];

  Map<String, dynamic> toJson() => {
        'sender': sender,
        'messageId': messageId,
        'body': body,
        'editedAt': editedAt,
        if (timestamp != null) 'timestamp': timestamp,
        if (recipient != null) 'recipient': recipient,
        if (recipients != null) 'recipients': recipients,
        if (groupId != null) 'groupId': groupId,
        if (groupName != null) 'groupName': groupName,
        if (groupMembers != null) 'groupMembers': groupMembers,
        if (groupCreatedBy != null) 'groupCreatedBy': groupCreatedBy,
        if (groupAdmins != null) 'groupAdmins': groupAdmins,
        if (groupUpdatedAt != null) 'groupUpdatedAt': groupUpdatedAt,
        if (groupType != null) 'groupType': groupType == GroupType.community ? 'community' : 'group',
      };
}

/// Delete message payload
class DeleteMessagePayload extends Equatable {
  final String sender;
  final String messageId;
  final int deletedAt;
  final int? timestamp;
  final String? recipient;
  final List<String>? recipients;
  final String? groupId;
  final String? groupName;
  final List<String>? groupMembers;
  final String? groupCreatedBy;
  final List<String>? groupAdmins;
  final int? groupUpdatedAt;
  final GroupType? groupType;

  const DeleteMessagePayload({
    required this.sender,
    required this.messageId,
    required this.deletedAt,
    this.timestamp,
    this.recipient,
    this.recipients,
    this.groupId,
    this.groupName,
    this.groupMembers,
    this.groupCreatedBy,
    this.groupAdmins,
    this.groupUpdatedAt,
    this.groupType,
  });

  @override
  List<Object?> get props => [
        sender,
        messageId,
        deletedAt,
        timestamp,
        recipient,
        recipients,
        groupId,
        groupName,
        groupMembers,
        groupCreatedBy,
        groupAdmins,
        groupUpdatedAt,
        groupType,
      ];

  Map<String, dynamic> toJson() => {
        'sender': sender,
        'messageId': messageId,
        'deletedAt': deletedAt,
        if (timestamp != null) 'timestamp': timestamp,
        if (recipient != null) 'recipient': recipient,
        if (recipients != null) 'recipients': recipients,
        if (groupId != null) 'groupId': groupId,
        if (groupName != null) 'groupName': groupName,
        if (groupMembers != null) 'groupMembers': groupMembers,
        if (groupCreatedBy != null) 'groupCreatedBy': groupCreatedBy,
        if (groupAdmins != null) 'groupAdmins': groupAdmins,
        if (groupUpdatedAt != null) 'groupUpdatedAt': groupUpdatedAt,
        if (groupType != null) 'groupType': groupType == GroupType.community ? 'community' : 'group',
      };
}

/// Session response from auth endpoints
class SessionResponse extends Equatable {
  final bool authenticated;
  final String? user;
  final String? csrfToken;
  final String? status;
  final String? message;
  final int? retryAfterSeconds;
  final bool? verificationRequired;
  final bool? codeSent;
  final int? expiresInSeconds;

  const SessionResponse({
    required this.authenticated,
    this.user,
    this.csrfToken,
    this.status,
    this.message,
    this.retryAfterSeconds,
    this.verificationRequired,
    this.codeSent,
    this.expiresInSeconds,
  });

  @override
  List<Object?> get props => [
        authenticated,
        user,
        csrfToken,
        status,
        message,
        retryAfterSeconds,
        verificationRequired,
        codeSent,
        expiresInSeconds,
      ];

  factory SessionResponse.fromJson(Map<String, dynamic> json) {
    return SessionResponse(
      authenticated: json['authenticated'] as bool? ?? false,
      user: json['user'] as String?,
      csrfToken: json['csrfToken'] as String?,
      status: json['status'] as String?,
      message: json['message'] as String?,
      retryAfterSeconds: json['retryAfterSeconds'] as int?,
      verificationRequired: json['verificationRequired'] as bool?,
      codeSent: json['codeSent'] as bool?,
      expiresInSeconds: json['expiresInSeconds'] as int?,
    );
  }
}

/// Upload response
class UploadResponse extends Equatable {
  final String? status;
  final String? url;
  final String? thumbUrl;
  final String? type;

  const UploadResponse({
    this.status,
    this.url,
    this.thumbUrl,
    this.type,
  });

  @override
  List<Object?> get props => [status, url, thumbUrl, type];

  factory UploadResponse.fromJson(Map<String, dynamic> json) {
    return UploadResponse(
      status: json['status'] as String?,
      url: json['url'] as String?,
      thumbUrl: json['thumbUrl'] as String?,
      type: json['type'] as String?,
    );
  }
}

/// Shuttle order submit payload
class ShuttleOrderSubmitPayload extends Equatable {
  final String employee;
  final String date;
  final String dateAlt;
  final String shift;
  final String station;
  final String status;

  const ShuttleOrderSubmitPayload({
    required this.employee,
    required this.date,
    required this.dateAlt,
    required this.shift,
    required this.station,
    required this.status,
  });

  @override
  List<Object?> get props => [employee, date, dateAlt, shift, station, status];

  Map<String, dynamic> toJson() => {
        'employee': employee,
        'date': date,
        'dateAlt': dateAlt,
        'shift': shift,
        'station': station,
        'status': status,
      };
}

/// Shuttle user order payload
class ShuttleUserOrderPayload extends Equatable {
  final String? id;
  final String? sheetRow;
  final String? employee;
  final String? employeePhone;
  final String? date;
  final String? dateIso;
  final String? dayName;
  final String? shift;
  final String? shiftLabel;
  final String? shiftValue;
  final String? station;
  final String? status;
  final String? statusValue;
  final String? submittedAt;
  final String? cancelledAt;
  final bool isCancelled;
  final bool isOngoing;

  const ShuttleUserOrderPayload({
    this.id,
    this.sheetRow,
    this.employee,
    this.employeePhone,
    this.date,
    this.dateIso,
    this.dayName,
    this.shift,
    this.shiftLabel,
    this.shiftValue,
    this.station,
    this.status,
    this.statusValue,
    this.submittedAt,
    this.cancelledAt,
    this.isCancelled = false,
    this.isOngoing = false,
  });

  @override
  List<Object?> get props => [
        id,
        sheetRow,
        employee,
        employeePhone,
        date,
        dateIso,
        dayName,
        shift,
        shiftLabel,
        shiftValue,
        station,
        status,
        statusValue,
        submittedAt,
        cancelledAt,
        isCancelled,
        isOngoing,
      ];

  factory ShuttleUserOrderPayload.fromJson(Map<String, dynamic> json) {
    return ShuttleUserOrderPayload(
      id: json['id']?.toString(),
      sheetRow: json['sheetRow']?.toString(),
      employee: json['employee'] as String?,
      employeePhone: json['employeePhone'] as String?,
      date: json['date'] as String?,
      dateIso: json['dateIso'] as String?,
      dayName: json['dayName'] as String?,
      shift: json['shift'] as String?,
      shiftLabel: json['shiftLabel'] as String?,
      shiftValue: json['shiftValue'] as String?,
      station: json['station'] as String?,
      status: json['status'] as String?,
      statusValue: json['statusValue'] as String?,
      submittedAt: json['submittedAt']?.toString(),
      cancelledAt: json['cancelledAt']?.toString(),
      isCancelled: json['isCancelled'] as bool? ?? false,
      isOngoing: json['isOngoing'] as bool? ?? false,
    );
  }
}
