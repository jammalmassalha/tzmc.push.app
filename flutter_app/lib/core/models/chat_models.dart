/// Core domain models for the chat application.
///
/// These models mirror the TypeScript interfaces from the Angular frontend
/// defined in frontend/src/app/core/models/chat.models.ts
library;

import 'package:equatable/equatable.dart';

/// Group type enumeration
enum GroupType { group, community }

/// Message delivery status
enum DeliveryStatus {
  pending,
  sent,
  queued,
  failed,
  delivered,
  read,
}

/// Message reaction
class MessageReaction extends Equatable {
  final String emoji;
  final String reactor;
  final String? reactorName;

  const MessageReaction({
    required this.emoji,
    required this.reactor,
    this.reactorName,
  });

  @override
  List<Object?> get props => [emoji, reactor, reactorName];

  factory MessageReaction.fromJson(Map<String, dynamic> json) {
    return MessageReaction(
      emoji: json['emoji'] as String? ?? '',
      reactor: json['reactor'] as String? ?? '',
      reactorName: json['reactorName'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'emoji': emoji,
        'reactor': reactor,
        if (reactorName != null) 'reactorName': reactorName,
      };
}

/// Contact model
class Contact extends Equatable {
  final String username;
  final String displayName;
  final String? info;
  final String? phone;
  final String? upic;
  final int? status;

  const Contact({
    required this.username,
    required this.displayName,
    this.info,
    this.phone,
    this.upic,
    this.status,
  });

  @override
  List<Object?> get props => [username, displayName, info, phone, upic, status];

  factory Contact.fromJson(Map<String, dynamic> json) {
    final fullName = (json['fullName'] ?? json['full_name'] ?? '').toString().trim();
    final displayNameRaw = (json['displayName'] ?? '').toString().trim();
    final name = _parseNameAndInfo(fullName.isNotEmpty ? fullName : displayNameRaw);

    int? status;
    final statusVal = json['status'] ?? json['accessStatus'] ?? json['userStatus'];
    if (statusVal is int) {
      status = statusVal;
    } else if (statusVal != null) {
      status = int.tryParse(statusVal.toString());
    }

    return Contact(
      username: (json['username'] ?? '').toString().trim(),
      displayName: name.name,
      info: name.info,
      phone: (json['phone'] ?? '').toString().trim().nullIfEmpty,
      upic: (json['upic'] ?? '').toString().trim().nullIfEmpty,
      status: status,
    );
  }

  Map<String, dynamic> toJson() => {
        'username': username,
        'displayName': displayName,
        if (info != null) 'info': info,
        if (phone != null) 'phone': phone,
        if (upic != null) 'upic': upic,
        if (status != null) 'status': status,
      };

  static ({String name, String? info}) _parseNameAndInfo(String value) {
    if (value.isEmpty) return (name: '', info: null);

    final infoParts = <String>[];
    var withoutParentheses = value.replaceAllMapped(
      RegExp(r'\(([^()]*)\)'),
      (match) {
        final group = match.group(1)?.replaceAll(RegExp(r'\s+'), ' ').trim() ?? '';
        if (group.isNotEmpty) infoParts.add(group);
        return ' ';
      },
    );

    final cleanedName = withoutParentheses.replaceAll(RegExp(r'\s+'), ' ').trim();
    final mergedInfo = infoParts.isNotEmpty ? infoParts.join(' | ') : null;
    return (name: cleanedName, info: mergedInfo);
  }
}

/// Chat group model
class ChatGroup extends Equatable {
  final String id;
  final String name;
  final List<String> members;
  final List<String>? admins;
  final String createdBy;
  final int updatedAt;
  final GroupType type;

  const ChatGroup({
    required this.id,
    required this.name,
    required this.members,
    this.admins,
    required this.createdBy,
    required this.updatedAt,
    required this.type,
  });

  @override
  List<Object?> get props => [id, name, members, admins, createdBy, updatedAt, type];

  factory ChatGroup.fromJson(Map<String, dynamic> json) {
    final id = (json['id'] ?? json['groupID'] ?? json['groupId'] ?? '').toString().trim();
    final name = (json['name'] ?? json['title'] ?? json['groupName'] ?? '').toString().trim();

    List<String> parseStringList(dynamic value) {
      if (value == null) return [];
      if (value is List) {
        return value.map((e) => e.toString().trim()).where((e) => e.isNotEmpty).toList();
      }
      return [];
    }

    final members = parseStringList(json['members'] ?? json['memberList'] ?? json['groupMembers']);
    final admins = parseStringList(json['admins'] ?? json['groupAdmins']);
    final createdBy = (json['createdBy'] ?? json['groupCreatedBy'] ?? '').toString().trim();
    final updatedAt = (json['updatedAt'] ?? json['groupUpdatedAt'] ?? DateTime.now().millisecondsSinceEpoch) as int;
    final typeStr = (json['type'] ?? json['groupType'] ?? 'group').toString();

    return ChatGroup(
      id: id,
      name: name,
      members: members,
      admins: admins.isEmpty ? null : admins,
      createdBy: createdBy.isNotEmpty ? createdBy : (admins.isNotEmpty ? admins.first : ''),
      updatedAt: updatedAt,
      type: typeStr == 'community' ? GroupType.community : GroupType.group,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'members': members,
        if (admins != null) 'admins': admins,
        'createdBy': createdBy,
        'updatedAt': updatedAt,
        'type': type == GroupType.community ? 'community' : 'group',
      };
}

/// Message reference for replies
class MessageReference extends Equatable {
  final String messageId;
  final String sender;
  final String? senderDisplayName;
  final String? body;
  final String? imageUrl;

  const MessageReference({
    required this.messageId,
    required this.sender,
    this.senderDisplayName,
    this.body,
    this.imageUrl,
  });

  @override
  List<Object?> get props => [messageId, sender, senderDisplayName, body, imageUrl];

  factory MessageReference.fromJson(Map<String, dynamic> json) {
    return MessageReference(
      messageId: json['messageId'] as String? ?? '',
      sender: json['sender'] as String? ?? '',
      senderDisplayName: json['senderDisplayName'] as String?,
      body: json['body'] as String?,
      imageUrl: json['imageUrl'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'messageId': messageId,
        'sender': sender,
        if (senderDisplayName != null) 'senderDisplayName': senderDisplayName,
        if (body != null) 'body': body,
        if (imageUrl != null) 'imageUrl': imageUrl,
      };
}

/// Chat message model
class ChatMessage extends Equatable {
  final String id;
  final String messageId;
  final String chatId;
  final String sender;
  final String? senderDisplayName;
  final String? recordType;
  final String body;
  final String? imageUrl;
  final String? thumbnailUrl;
  final String? fileUrl;
  final MessageDirection direction;
  final int timestamp;
  final DeliveryStatus deliveryStatus;
  final String? groupId;
  final String? groupName;
  final GroupType? groupType;
  final List<MessageReaction>? reactions;
  final int? editedAt;
  final int? deletedAt;
  final MessageReference? replyTo;
  final bool forwarded;
  final String? forwardedFrom;
  final String? forwardedFromName;
  final int? userReceivedTime;

  const ChatMessage({
    required this.id,
    required this.messageId,
    required this.chatId,
    required this.sender,
    this.senderDisplayName,
    this.recordType,
    required this.body,
    this.imageUrl,
    this.thumbnailUrl,
    this.fileUrl,
    required this.direction,
    required this.timestamp,
    required this.deliveryStatus,
    this.groupId,
    this.groupName,
    this.groupType,
    this.reactions,
    this.editedAt,
    this.deletedAt,
    this.replyTo,
    this.forwarded = false,
    this.forwardedFrom,
    this.forwardedFromName,
    this.userReceivedTime,
  });

  @override
  List<Object?> get props => [
        id,
        messageId,
        chatId,
        sender,
        senderDisplayName,
        recordType,
        body,
        imageUrl,
        thumbnailUrl,
        fileUrl,
        direction,
        timestamp,
        deliveryStatus,
        groupId,
        groupName,
        groupType,
        reactions,
        editedAt,
        deletedAt,
        replyTo,
        forwarded,
        forwardedFrom,
        forwardedFromName,
        userReceivedTime,
      ];

  /// Create a copy with updated fields
  ChatMessage copyWith({
    String? id,
    String? messageId,
    String? chatId,
    String? sender,
    String? senderDisplayName,
    String? recordType,
    String? body,
    String? imageUrl,
    String? thumbnailUrl,
    String? fileUrl,
    MessageDirection? direction,
    int? timestamp,
    DeliveryStatus? deliveryStatus,
    String? groupId,
    String? groupName,
    GroupType? groupType,
    List<MessageReaction>? reactions,
    int? editedAt,
    int? deletedAt,
    MessageReference? replyTo,
    bool? forwarded,
    String? forwardedFrom,
    String? forwardedFromName,
    int? userReceivedTime,
  }) {
    return ChatMessage(
      id: id ?? this.id,
      messageId: messageId ?? this.messageId,
      chatId: chatId ?? this.chatId,
      sender: sender ?? this.sender,
      senderDisplayName: senderDisplayName ?? this.senderDisplayName,
      recordType: recordType ?? this.recordType,
      body: body ?? this.body,
      imageUrl: imageUrl ?? this.imageUrl,
      thumbnailUrl: thumbnailUrl ?? this.thumbnailUrl,
      fileUrl: fileUrl ?? this.fileUrl,
      direction: direction ?? this.direction,
      timestamp: timestamp ?? this.timestamp,
      deliveryStatus: deliveryStatus ?? this.deliveryStatus,
      groupId: groupId ?? this.groupId,
      groupName: groupName ?? this.groupName,
      groupType: groupType ?? this.groupType,
      reactions: reactions ?? this.reactions,
      editedAt: editedAt ?? this.editedAt,
      deletedAt: deletedAt ?? this.deletedAt,
      replyTo: replyTo ?? this.replyTo,
      forwarded: forwarded ?? this.forwarded,
      forwardedFrom: forwardedFrom ?? this.forwardedFrom,
      forwardedFromName: forwardedFromName ?? this.forwardedFromName,
      userReceivedTime: userReceivedTime ?? this.userReceivedTime,
    );
  }
}

/// Message direction
enum MessageDirection { incoming, outgoing }

/// Chat list item for displaying in the chat list
class ChatListItem extends Equatable {
  final String id;
  final String title;
  final String? info;
  final String subtitle;
  final int lastTimestamp;
  final int unread;
  final bool isGroup;
  final bool pinned;
  final String? avatarUrl;

  const ChatListItem({
    required this.id,
    required this.title,
    this.info,
    required this.subtitle,
    required this.lastTimestamp,
    required this.unread,
    required this.isGroup,
    required this.pinned,
    this.avatarUrl,
  });

  @override
  List<Object?> get props => [id, title, info, subtitle, lastTimestamp, unread, isGroup, pinned, avatarUrl];
}

/// Incoming server message (raw message from API)
class IncomingServerMessage extends Equatable {
  final String? messageId;
  final String? sender;
  final String? toUser;
  final String? recipient;
  final String? type;
  final String? chatId;
  final bool? isTyping;
  final int? editedAt;
  final int? deletedAt;
  final List<String>? messageIds;
  final int? readAt;
  final String? targetMessageId;
  final String? emoji;
  final String? reactor;
  final String? reactorName;
  final String? body;
  final int? timestamp;
  final String? imageUrl;
  final String? fileUrl;
  final String? groupId;
  final String? groupName;
  final List<String>? groupMembers;
  final String? groupCreatedBy;
  final List<String>? groupAdmins;
  final int? groupUpdatedAt;
  final String? groupType;
  final String? groupSenderName;
  final String? replyToMessageId;
  final String? replyToSender;
  final String? replyToSenderName;
  final String? replyToBody;
  final String? replyToImageUrl;
  final bool? forwarded;
  final String? forwardedFrom;
  final String? forwardedFromName;
  final int? userReceivedTime;

  const IncomingServerMessage({
    this.messageId,
    this.sender,
    this.toUser,
    this.recipient,
    this.type,
    this.chatId,
    this.isTyping,
    this.editedAt,
    this.deletedAt,
    this.messageIds,
    this.readAt,
    this.targetMessageId,
    this.emoji,
    this.reactor,
    this.reactorName,
    this.body,
    this.timestamp,
    this.imageUrl,
    this.fileUrl,
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
    this.forwarded,
    this.forwardedFrom,
    this.forwardedFromName,
    this.userReceivedTime,
  });

  @override
  List<Object?> get props => [
        messageId,
        sender,
        toUser,
        recipient,
        type,
        chatId,
        isTyping,
        editedAt,
        deletedAt,
        messageIds,
        readAt,
        targetMessageId,
        emoji,
        reactor,
        reactorName,
        body,
        timestamp,
        imageUrl,
        fileUrl,
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
        userReceivedTime,
      ];

  factory IncomingServerMessage.fromJson(Map<String, dynamic> json) {
    return IncomingServerMessage(
      messageId: json['messageId'] as String?,
      sender: json['sender'] as String?,
      toUser: json['toUser'] as String?,
      recipient: json['recipient'] as String?,
      type: json['type'] as String?,
      chatId: json['chatId'] as String?,
      isTyping: json['isTyping'] as bool?,
      editedAt: json['editedAt'] as int?,
      deletedAt: json['deletedAt'] as int?,
      messageIds: (json['messageIds'] as List?)?.cast<String>(),
      readAt: json['readAt'] as int?,
      targetMessageId: json['targetMessageId'] as String?,
      emoji: json['emoji'] as String?,
      reactor: json['reactor'] as String?,
      reactorName: json['reactorName'] as String?,
      body: json['body'] as String?,
      timestamp: json['timestamp'] as int?,
      imageUrl: json['imageUrl'] as String?,
      fileUrl: json['fileUrl'] as String?,
      groupId: json['groupId'] as String?,
      groupName: json['groupName'] as String?,
      groupMembers: (json['groupMembers'] as List?)?.cast<String>(),
      groupCreatedBy: json['groupCreatedBy'] as String?,
      groupAdmins: (json['groupAdmins'] as List?)?.cast<String>(),
      groupUpdatedAt: json['groupUpdatedAt'] as int?,
      groupType: json['groupType'] as String?,
      groupSenderName: json['groupSenderName'] as String?,
      replyToMessageId: json['replyToMessageId'] as String?,
      replyToSender: json['replyToSender'] as String?,
      replyToSenderName: json['replyToSenderName'] as String?,
      replyToBody: json['replyToBody'] as String?,
      replyToImageUrl: json['replyToImageUrl'] as String?,
      forwarded: json['forwarded'] as bool?,
      forwardedFrom: json['forwardedFrom'] as String?,
      forwardedFromName: json['forwardedFromName'] as String?,
      userReceivedTime: json['userReceivedTime'] as int?,
    );
  }

  Map<String, dynamic> toJson() => {
        if (messageId != null) 'messageId': messageId,
        if (sender != null) 'sender': sender,
        if (toUser != null) 'toUser': toUser,
        if (recipient != null) 'recipient': recipient,
        if (type != null) 'type': type,
        if (chatId != null) 'chatId': chatId,
        if (isTyping != null) 'isTyping': isTyping,
        if (editedAt != null) 'editedAt': editedAt,
        if (deletedAt != null) 'deletedAt': deletedAt,
        if (messageIds != null) 'messageIds': messageIds,
        if (readAt != null) 'readAt': readAt,
        if (targetMessageId != null) 'targetMessageId': targetMessageId,
        if (emoji != null) 'emoji': emoji,
        if (reactor != null) 'reactor': reactor,
        if (reactorName != null) 'reactorName': reactorName,
        if (body != null) 'body': body,
        if (timestamp != null) 'timestamp': timestamp,
        if (imageUrl != null) 'imageUrl': imageUrl,
        if (fileUrl != null) 'fileUrl': fileUrl,
        if (groupId != null) 'groupId': groupId,
        if (groupName != null) 'groupName': groupName,
        if (groupMembers != null) 'groupMembers': groupMembers,
        if (groupCreatedBy != null) 'groupCreatedBy': groupCreatedBy,
        if (groupAdmins != null) 'groupAdmins': groupAdmins,
        if (groupUpdatedAt != null) 'groupUpdatedAt': groupUpdatedAt,
        if (groupType != null) 'groupType': groupType,
        if (groupSenderName != null) 'groupSenderName': groupSenderName,
        if (replyToMessageId != null) 'replyToMessageId': replyToMessageId,
        if (replyToSender != null) 'replyToSender': replyToSender,
        if (replyToSenderName != null) 'replyToSenderName': replyToSenderName,
        if (replyToBody != null) 'replyToBody': replyToBody,
        if (replyToImageUrl != null) 'replyToImageUrl': replyToImageUrl,
        if (forwarded != null) 'forwarded': forwarded,
        if (forwardedFrom != null) 'forwardedFrom': forwardedFrom,
        if (forwardedFromName != null) 'forwardedFromName': forwardedFromName,
        if (userReceivedTime != null) 'userReceivedTime': userReceivedTime,
      };
}

// ---------------------------------------------------------------------------
// Persisted Chat State
// ---------------------------------------------------------------------------

/// State model for persisting chat data to the database.
///
/// Used by ChatDatabase to persist and restore the full chat state.
class PersistedChatState extends Equatable {
  final List<Contact> contacts;
  final List<ChatGroup> groups;
  final Map<String, int> unreadByChat;
  final List<ChatMessage> messages;

  const PersistedChatState({
    this.contacts = const [],
    this.groups = const [],
    this.unreadByChat = const {},
    this.messages = const [],
  });

  @override
  List<Object?> get props => [contacts, groups, unreadByChat, messages];
}

/// Extension for null-if-empty string handling
extension StringNullIfEmpty on String {
  String? get nullIfEmpty => isEmpty ? null : this;
}
