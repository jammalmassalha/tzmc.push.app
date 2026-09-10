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

/// Receipt status of an outgoing message, derived from the lifecycle
/// timestamps (see [ChatMessage.receiptStatus]):
///   • sending   — not yet stored on the server (no tick / clock)
///   • sent      — stored on the server (single grey tick ✓)
///   • delivered — received on the recipient's device (double grey tick ✓✓)
///   • read      — read by the recipient (double blue tick ✓✓)
enum MessageReceiptStatus { sending, sent, delivered, read }

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
    final withoutParentheses = value.replaceAllMapped(
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

/// Community group configuration — mirrors Angular's CommunityGroupConfig.
///
/// Groups with no [staticMembers] (or an empty list) are open to all users.
/// Groups with a non-empty [staticMembers] list are restricted to those users.
/// [allowedWriters] are the users permitted to post messages to the group.
class CommunityGroupConfig {
  final String id;
  final String name;
  final List<String>? staticMembers;
  final List<String> allowedWriters;

  const CommunityGroupConfig({
    required this.id,
    required this.name,
    this.staticMembers,
    this.allowedWriters = const [],
  });

  factory CommunityGroupConfig.fromJson(Map<String, dynamic> json) {
    List<String> parseStringList(dynamic value) {
      if (value == null) return const [];
      if (value is List) {
        return value.map((e) => e.toString().trim()).where((e) => e.isNotEmpty).toList();
      }
      return const [];
    }

    final parsed = parseStringList(json['staticMembers']);
    return CommunityGroupConfig(
      id: (json['id'] ?? '').toString().trim(),
      name: (json['name'] ?? '').toString().trim(),
      staticMembers: parsed.isNotEmpty ? parsed : null,
      allowedWriters: parseStringList(json['allowedWriters']),
    );
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

  /// Sender-side dispatch time. Authoritative key for chronological ordering
  /// of messages inside a conversation (see [effectiveSentTime]).
  final DateTime? sentDateTime;

  /// Server ingest time.
  final DateTime? receiveDateTime;

  /// Recipient read time.
  final DateTime? readDateTime;

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
    this.sentDateTime,
    this.receiveDateTime,
    this.readDateTime,
  });

  /// Epoch milliseconds used for strict chronological ordering:
  /// prefers [sentDateTime] and falls back to the legacy [timestamp].
  int get effectiveSentTime => sentDateTime?.millisecondsSinceEpoch ?? timestamp;

  /// Receipt status derived from the lifecycle timestamps, falling back to
  /// [deliveryStatus] for optimistic/local messages that have no timestamps
  /// yet. Timestamps and the transport-level status never downgrade each
  /// other — the highest known state wins.
  MessageReceiptStatus get receiptStatus {
    if (readDateTime != null || deliveryStatus == DeliveryStatus.read) {
      return MessageReceiptStatus.read;
    }
    if (receiveDateTime != null || deliveryStatus == DeliveryStatus.delivered) {
      return MessageReceiptStatus.delivered;
    }
    if (sentDateTime != null &&
        deliveryStatus != DeliveryStatus.pending &&
        deliveryStatus != DeliveryStatus.queued &&
        deliveryStatus != DeliveryStatus.failed) {
      return MessageReceiptStatus.sent;
    }
    if (deliveryStatus == DeliveryStatus.sent) return MessageReceiptStatus.sent;
    return MessageReceiptStatus.sending;
  }

  /// Parses a flexible timestamp value (ISO 8601 string, epoch milliseconds as
  /// int/num/string, or DateTime) into a UTC [DateTime]. Returns null when the
  /// value is missing or unparseable.
  static DateTime? parseFlexibleDateTime(dynamic value) {
    if (value == null) return null;
    if (value is DateTime) return value.toUtc();
    if (value is num) {
      final ms = value.toInt();
      if (ms <= 0) return null;
      return DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);
    }
    final text = value.toString().trim();
    if (text.isEmpty) return null;
    final numeric = int.tryParse(text);
    if (numeric != null) {
      if (numeric <= 0) return null;
      return DateTime.fromMillisecondsSinceEpoch(numeric, isUtc: true);
    }
    return DateTime.tryParse(text)?.toUtc();
  }

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
        sentDateTime,
        receiveDateTime,
        readDateTime,
      ];

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    return ChatMessage(
      id: json['id'] as String,
      messageId: json['messageId'] as String,
      chatId: json['chatId'] as String,
      sender: json['sender'] as String,
      senderDisplayName: json['senderDisplayName'] as String?,
      recordType: json['recordType'] as String?,
      body: json['body'] as String,
      imageUrl: json['imageUrl'] as String?,
      thumbnailUrl: json['thumbnailUrl'] as String?,
      fileUrl: json['fileUrl'] as String?,
      direction: MessageDirection.values.firstWhere(
        (e) => e.name == json['direction'],
        orElse: () => MessageDirection.incoming,
      ),
      timestamp: json['timestamp'] as int,
      deliveryStatus: DeliveryStatus.values.firstWhere(
        (e) => e.name == json['deliveryStatus'],
        orElse: () => DeliveryStatus.delivered,
      ),
      groupId: json['groupId'] as String?,
      groupName: json['groupName'] as String?,
      groupType: json['groupType'] != null
          ? GroupType.values.firstWhere(
              (e) => e.name == json['groupType'],
              orElse: () => GroupType.group,
            )
          : null,
      reactions: json['reactions'] != null
          ? (json['reactions'] as List)
              .map((r) => MessageReaction.fromJson(r as Map<String, dynamic>))
              .toList()
          : null,
      editedAt: json['editedAt'] as int?,
      deletedAt: json['deletedAt'] as int?,
      replyTo: json['replyTo'] != null
          ? MessageReference.fromJson(json['replyTo'] as Map<String, dynamic>)
          : null,
      forwarded: json['forwarded'] as bool? ?? false,
      forwardedFrom: json['forwardedFrom'] as String?,
      forwardedFromName: json['forwardedFromName'] as String?,
      userReceivedTime: json['userReceivedTime'] as int?,
      sentDateTime: parseFlexibleDateTime(json['sentDateTime']),
      receiveDateTime: parseFlexibleDateTime(json['receiveDateTime']),
      readDateTime: parseFlexibleDateTime(json['readDateTime']),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'messageId': messageId,
        'chatId': chatId,
        'sender': sender,
        'senderDisplayName': senderDisplayName,
        'recordType': recordType,
        'body': body,
        'imageUrl': imageUrl,
        'thumbnailUrl': thumbnailUrl,
        'fileUrl': fileUrl,
        'direction': direction.name,
        'timestamp': timestamp,
        'deliveryStatus': deliveryStatus.name,
        'groupId': groupId,
        'groupName': groupName,
        'groupType': groupType?.name,
        'reactions': reactions?.map((r) => r.toJson()).toList(),
        'editedAt': editedAt,
        'deletedAt': deletedAt,
        'replyTo': replyTo?.toJson(),
        'forwarded': forwarded,
        'forwardedFrom': forwardedFrom,
        'forwardedFromName': forwardedFromName,
        'userReceivedTime': userReceivedTime,
        'sentDateTime': sentDateTime?.millisecondsSinceEpoch,
        'receiveDateTime': receiveDateTime?.millisecondsSinceEpoch,
        'readDateTime': readDateTime?.millisecondsSinceEpoch,
      };

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
    DateTime? sentDateTime,
    DateTime? receiveDateTime,
    DateTime? readDateTime,
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
      sentDateTime: sentDateTime ?? this.sentDateTime,
      receiveDateTime: receiveDateTime ?? this.receiveDateTime,
      readDateTime: readDateTime ?? this.readDateTime,
    );
  }
}

/// Message direction
enum MessageDirection { incoming, outgoing }

/// Comparator ordering messages strictly chronologically by their effective
/// sent time ([ChatMessage.effectiveSentTime], i.e. sentDateTime ASC with a
/// legacy timestamp fallback). Ties break on messageId for stability.
int compareMessagesBySentTimeAsc(ChatMessage a, ChatMessage b) {
  final byTime = a.effectiveSentTime.compareTo(b.effectiveSentTime);
  if (byTime != 0) return byTime;
  return a.messageId.compareTo(b.messageId);
}

/// Reverse-chronological variant of [compareMessagesBySentTimeAsc], used by
/// the in-memory store which keeps chat lists newest-first.
int compareMessagesBySentTimeDesc(ChatMessage a, ChatMessage b) =>
    compareMessagesBySentTimeAsc(b, a);

/// Chat list item for displaying in the chat list
class ChatListItem extends Equatable {
  final String id;
  final String title;
  final String? info;
  final String? phone;
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
    this.phone,
    required this.subtitle,
    required this.lastTimestamp,
    required this.unread,
    required this.isGroup,
    required this.pinned,
    this.avatarUrl,
  });

  @override
  List<Object?> get props => [id, title, info, phone, subtitle, lastTimestamp, unread, isGroup, pinned, avatarUrl];
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

  /// Delivery acknowledgment time (epoch ms) carried by `delivery-receipt`
  /// events.
  final int? deliveredAt;
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

  /// Sender dispatch time in epoch ms (parsed from ISO 8601 or epoch values).
  final int? sentDateTime;

  /// Server ingest time in epoch ms.
  final int? receiveDateTime;

  /// Recipient read time in epoch ms.
  final int? readDateTime;

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
    this.deliveredAt,
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
    this.sentDateTime,
    this.receiveDateTime,
    this.readDateTime,
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
        deliveredAt,
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
        sentDateTime,
        receiveDateTime,
        readDateTime,
      ];

  factory IncomingServerMessage.fromJson(Map<String, dynamic> json) {
    String? asString(dynamic value) {
      if (value == null) return null;
      final text = value.toString().trim();
      return text.isEmpty ? null : text;
    }

    int? asInt(dynamic value) {
      if (value == null) return null;
      if (value is int) return value;
      if (value is num) return value.toInt();
      return int.tryParse(value.toString().trim());
    }

    List<String>? asStringList(dynamic value) {
      if (value == null) return null;
      if (value is List) {
        final values = value.map((e) => e.toString().trim()).where((e) => e.isNotEmpty).toList();
        return values.isEmpty ? null : values;
      }
      final text = value.toString().trim();
      if (text.isEmpty) return null;
      final values = text.split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
      return values.isEmpty ? null : values;
    }

    final lat = asString(json['latitude'] ?? json['lat']);
    final lon = asString(json['longitude'] ?? json['lng'] ?? json['lon']);
    final locationUrl = asString(json['locationUrl'] ?? json['location']);
    final locationBody = (lat != null && lon != null)
        ? '📍 https://www.google.com/maps?q=$lat,$lon'
        : locationUrl;
    final body = asString(
      json['body'] ??
      json['message'] ??
      json['messageText'] ??
      json['groupMessageText'] ??
      json['reply'],
    ) ?? locationBody;

    return IncomingServerMessage(
      messageId: asString(json['messageId'] ?? json['msgId']),
      sender: asString(json['sender'] ?? json['from'] ?? json['fromUser']),
      toUser: asString(json['toUser'] ?? json['to']),
      recipient: asString(json['recipient']),
      type: asString(json['type']),
      chatId: asString(json['chatId']),
      isTyping: json['isTyping'] as bool?,
      editedAt: asInt(json['editedAt']),
      deletedAt: asInt(json['deletedAt']),
      messageIds: asStringList(json['messageIds']),
      readAt: asInt(json['readAt']),
      deliveredAt: asInt(json['deliveredAt']),
      targetMessageId: asString(json['targetMessageId']),
      emoji: asString(json['emoji']),
      reactor: asString(json['reactor']),
      reactorName: asString(json['reactorName']),
      body: body,
      timestamp: asInt(json['timestamp']),
      imageUrl: asString(json['imageUrl'] ?? json['image'] ?? json['imageURL']),
      fileUrl: asString(json['fileUrl'] ?? json['file'] ?? json['attachmentUrl'] ?? json['url']),
      groupId: asString(json['groupId']),
      groupName: asString(json['groupName']),
      groupMembers: asStringList(json['groupMembers']),
      groupCreatedBy: asString(json['groupCreatedBy']),
      groupAdmins: asStringList(json['groupAdmins']),
      groupUpdatedAt: asInt(json['groupUpdatedAt']),
      groupType: asString(json['groupType']),
      groupSenderName: asString(json['groupSenderName'] ?? json['senderName'] ?? json['fromName']),
      replyToMessageId: asString(json['replyToMessageId']),
      replyToSender: asString(json['replyToSender']),
      replyToSenderName: asString(json['replyToSenderName']),
      replyToBody: asString(json['replyToBody']),
      replyToImageUrl: asString(json['replyToImageUrl']),
      forwarded: json['forwarded'] as bool?,
      forwardedFrom: asString(json['forwardedFrom']),
      forwardedFromName: asString(json['forwardedFromName']),
      userReceivedTime: asInt(json['userReceivedTime']),
      sentDateTime:
          ChatMessage.parseFlexibleDateTime(json['sentDateTime'])?.millisecondsSinceEpoch,
      receiveDateTime:
          ChatMessage.parseFlexibleDateTime(json['receiveDateTime'])?.millisecondsSinceEpoch,
      readDateTime:
          ChatMessage.parseFlexibleDateTime(json['readDateTime'])?.millisecondsSinceEpoch,
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
        if (deliveredAt != null) 'deliveredAt': deliveredAt,
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
        if (sentDateTime != null) 'sentDateTime': sentDateTime,
        if (receiveDateTime != null) 'receiveDateTime': receiveDateTime,
        if (readDateTime != null) 'readDateTime': readDateTime,
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
