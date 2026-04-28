/// Message composer widget - text input for sending messages.
///
/// Supports text input, image/file attachments, editing mode, and location sharing.
/// Works on both native and web platforms using XFile abstraction.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/models/chat_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/utils/toast_utils.dart';
import '../../../core/utils/xfile.dart' as xfile;

/// Message composer widget
class MessageComposer extends ConsumerStatefulWidget {
  final String chatId;
  final bool isGroup;
  final MessageReference? replyTo;
  final ChatMessage? editingMessage;
  final VoidCallback onMessageSent;

  const MessageComposer({
    super.key,
    required this.chatId,
    required this.isGroup,
    this.replyTo,
    this.editingMessage,
    required this.onMessageSent,
  });

  @override
  ConsumerState<MessageComposer> createState() => _MessageComposerState();
}

class _MessageComposerState extends ConsumerState<MessageComposer> {
  final _textController = TextEditingController();
  final _focusNode = FocusNode();
  bool _isSending = false;
  xfile.XFile? _selectedImage;
  xfile.XFile? _selectedFile;
  Uint8List? _selectedImageBytes; // For preview on all platforms

  @override
  void initState() {
    super.initState();
    if (widget.editingMessage != null) {
      _textController.text = widget.editingMessage!.body;
    }
  }

  @override
  void didUpdateWidget(covariant MessageComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.editingMessage != oldWidget.editingMessage) {
      if (widget.editingMessage != null) {
        _textController.text = widget.editingMessage!.body;
        _focusNode.requestFocus();
      } else {
        _textController.clear();
      }
    }
  }

  @override
  void dispose() {
    _textController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Mirror Angular's canSendToActiveChat: in community groups only admins
    // (or the creator) may send. Replace the composer with a banner so the
    // user understands why typing/attaching is disabled. Watch the store so
    // the banner clears immediately when the user is promoted to admin.
    ref.watch(chatStoreProvider);
    final notifier = ref.read(chatStoreProvider.notifier);
    final canSend = notifier.canSendToChat(widget.chatId);
    if (!canSend) {
      return SafeArea(
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            border: Border(
              top: BorderSide(
                color: Theme.of(context).dividerColor,
                width: 0.5,
              ),
            ),
          ),
          child: Row(
            children: [
              Icon(Icons.lock_outline,
                  size: 18,
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withAlpha((255 * 0.6).round())),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'רק מנהל יכול לשלוח בקבוצת קהילה',
                  textDirection: TextDirection.rtl,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withAlpha((255 * 0.7).round()),
                      ),
                ),
              ),
            ],
          ),
        ),
      );
    }

    // WhatsApp-style bar colours
    const Color barBackground = Color(0xFFF0F2F5);
    const Color fieldBackground = Colors.white;
    const Color sendGreen = Color(0xFF25D366);
    const Color iconColor = Color(0xFF8696A0);

    return SafeArea(
      child: Container(
        color: barBackground,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Attachment / image preview
            if (_selectedImage != null || _selectedFile != null)
              _AttachmentPreview(
                imageBytes: _selectedImageBytes,
                fileName: _selectedFile?.name,
                onRemove: () {
                  setState(() {
                    _selectedImage = null;
                    _selectedFile = null;
                    _selectedImageBytes = null;
                  });
                },
              ),

            // ── WhatsApp-style input row ──────────────────────────────────
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                // ── Rounded white text field ─────────────────────────────
                Expanded(
                  child: Container(
                    constraints: const BoxConstraints(maxHeight: 160),
                    decoration: BoxDecoration(
                      color: fieldBackground,
                      borderRadius: BorderRadius.circular(28),
                    ),
                    child: TextField(
                      controller: _textController,
                      focusNode: _focusNode,
                      maxLines: null,
                      keyboardType: TextInputType.multiline,
                      textInputAction: TextInputAction.newline,
                      textDirection: TextDirection.rtl,
                      style: const TextStyle(fontSize: 15),
                      decoration: InputDecoration(
                        hintText: 'הקלד הודעה...',
                        hintTextDirection: TextDirection.rtl,
                        hintStyle: const TextStyle(
                          color: Color(0xFF8696A0),
                          fontSize: 15,
                        ),
                        border: InputBorder.none,
                        // Emoji/sticker icon on the right (start in RTL)
                        suffixIcon: IconButton(
                          icon: const Icon(
                            Icons.emoji_emotions_outlined,
                            color: iconColor,
                            size: 24,
                          ),
                          onPressed: null, // placeholder
                          splashRadius: 20,
                        ),
                        // Attachment icon on the left (end in RTL)
                        prefixIcon: IconButton(
                          icon: const Icon(
                            Icons.attach_file,
                            color: iconColor,
                            size: 24,
                          ),
                          onPressed: _showAttachmentOptions,
                          tooltip: 'צרף קובץ',
                          splashRadius: 20,
                        ),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 4,
                          vertical: 10,
                        ),
                      ),
                      onSubmitted: (_) => _handleSend(),
                    ),
                  ),
                ),

                const SizedBox(width: 6),

                // ── Circular green send button ────────────────────────────
                _isSending
                    ? Container(
                        width: 48,
                        height: 48,
                        decoration: const BoxDecoration(
                          color: sendGreen,
                          shape: BoxShape.circle,
                        ),
                        child: const Center(
                          child: SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.5,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      )
                    : Material(
                        color: sendGreen,
                        shape: const CircleBorder(),
                        clipBehavior: Clip.antiAlias,
                        child: InkWell(
                          onTap: _handleSend,
                          child: SizedBox(
                            width: 48,
                            height: 48,
                            child: Icon(
                              widget.editingMessage != null
                                  ? Icons.check
                                  : Icons.send,
                              color: Colors.white,
                              size: 22,
                            ),
                          ),
                        ),
                      ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _showAttachmentOptions() {
    showModalBottomSheet(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera),
              title: const Text('צלם תמונה'),
              onTap: () {
                Navigator.of(context).pop();
                _pickImage(ImageSource.camera);
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_library),
              title: const Text('בחר מגלריה'),
              onTap: () {
                Navigator.of(context).pop();
                _pickImage(ImageSource.gallery);
              },
            ),
            ListTile(
              leading: const Icon(Icons.insert_drive_file),
              title: const Text('בחר קובץ'),
              onTap: () {
                Navigator.of(context).pop();
                _pickFile();
              },
            ),
            ListTile(
              leading: const Icon(Icons.location_on),
              title: const Text('שתף מיקום'),
              onTap: () {
                Navigator.of(context).pop();
                _shareLocation();
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _pickImage(ImageSource source) async {
    // On web, camera is not supported
    if (kIsWeb && source == ImageSource.camera) {
      showTopToast(context, 'צילום לא נתמך בדפדפן');
      return;
    }

    final picker = ImagePicker();
    final pickedFile = await picker.pickImage(
      source: source,
      maxWidth: 1920,
      maxHeight: 1920,
      imageQuality: 85,
    );

    if (pickedFile != null) {
      // Read bytes for preview and cross-platform XFile
      final bytes = await pickedFile.readAsBytes();
      final mimeType = xfile.XFileUtils.mimeTypeFromExtension(
        pickedFile.name.split('.').last,
      );

      setState(() {
        _selectedImage = xfile.XFile.fromBytes(
          name: pickedFile.name,
          bytes: bytes,
          mimeType: mimeType,
        );
        _selectedImageBytes = bytes;
        _selectedFile = null;
      });
    }
  }

  Future<void> _pickFile() async {
    // For now, show a placeholder message
    // File picking requires additional setup (file_picker package)
    showTopToast(context, 'בחירת קובץ - בקרוב');
  }

  /// Mirrors Angular's [shareLocation]: gets the device's GPS position and
  /// sends `📍 https://www.google.com/maps?q=<lat>,<lon>` as a text message.
  Future<void> _shareLocation() async {
    final overlay = Overlay.of(context, rootOverlay: true);
    try {
      // Check/request permission
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        showTopToastOnOverlay(
          overlay,
          'לא ניתן לקבל מיקום. אנא אשר הרשאות.',
          duration: const Duration(seconds: 3),
        );
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 15),
        ),
      );

      final lat = position.latitude.toStringAsFixed(6);
      final lon = position.longitude.toStringAsFixed(6);
      final mapLink = 'https://www.google.com/maps?q=$lat,$lon';
      final body = '📍 $mapLink';

      final chatStore = ref.read(chatStoreProvider.notifier);
      if (widget.isGroup) {
        await chatStore.sendGroupMessage(
          groupId: widget.chatId,
          body: body,
        );
      } else {
        await chatStore.sendDirectMessage(
          recipient: widget.chatId,
          body: body,
        );
      }
      widget.onMessageSent();
      showTopToastOnOverlay(overlay, 'המיקום נשלח.',
          duration: const Duration(seconds: 2));
    } catch (_) {
      showTopToastOnOverlay(
        overlay,
        'לא ניתן לקבל מיקום. אנא אשר הרשאות.',
        duration: const Duration(seconds: 3),
      );
    }
  }

  Future<void> _handleSend() async {
    final text = _textController.text.trim();
    if (text.isEmpty && _selectedImage == null && _selectedFile == null) {
      return;
    }

    final hasAttachment = _selectedImage != null || _selectedFile != null;
    final editingMessage = widget.editingMessage;
    final replyTo = widget.replyTo;
    final isGroup = widget.isGroup;
    final chatId = widget.chatId;

    // Snapshot attachments before we clear them so the in-flight upload can
    // complete even though the composer UI is reset immediately.
    final pendingImage = _selectedImage;
    final pendingFile = _selectedFile;

    // Optimistic UX: clear the input and selected attachments now so the
    // user can immediately type/send the next message. The chat store
    // already inserts the outgoing bubble synchronously; the actual API
    // call (and any uploads) run in the background. We only show a loader
    // when there's an attachment that needs uploading first — text-only
    // sends never block the UI.
    _textController.clear();
    setState(() {
      _selectedImage = null;
      _selectedFile = null;
      _selectedImageBytes = null;
      if (hasAttachment) {
        _isSending = true;
      }
    });
    widget.onMessageSent();

    final overlay = Overlay.of(context, rootOverlay: true);
    final errorColor = Theme.of(context).colorScheme.error;

    Future<void> doSend() async {
      try {
        String? imageUrl;
        String? fileUrl;

        // Upload image if selected
        if (pendingImage != null) {
          final api = ref.read(chatApiServiceProvider);
          final uploadResult = await api.uploadFile(pendingImage);
          imageUrl = uploadResult.url;
        }

        // Upload file if selected
        if (pendingFile != null) {
          final api = ref.read(chatApiServiceProvider);
          final uploadResult = await api.uploadFile(pendingFile);
          fileUrl = uploadResult.url;
        }

        final chatStore = ref.read(chatStoreProvider.notifier);

        if (editingMessage != null) {
          // Edit existing message
          await chatStore.editMessage(editingMessage.messageId, text);
        } else if (isGroup) {
          // Send group message
          await chatStore.sendGroupMessage(
            groupId: chatId,
            body: text,
            imageUrl: imageUrl,
            fileUrl: fileUrl,
            replyTo: replyTo,
          );
        } else {
          // Send direct message
          await chatStore.sendDirectMessage(
            recipient: chatId,
            body: text,
            imageUrl: imageUrl,
            fileUrl: fileUrl,
            replyTo: replyTo,
          );
        }
      } catch (e) {
        showTopToastOnOverlay(
          overlay,
          'שגיאה בשליחה: ${e.toString()}',
          backgroundColor: errorColor,
        );
      } finally {
        if (mounted && hasAttachment) {
          setState(() => _isSending = false);
        }
      }
    }

    // Fire-and-forget for text-only sends so the composer stays interactive
    // (no loader on the send button). For attachment uploads we still await
    // so the loader is shown until the upload finishes.
    if (hasAttachment) {
      await doSend();
    } else {
      unawaited(doSend());
    }
  }
}

/// Attachment preview widget (cross-platform)
class _AttachmentPreview extends StatelessWidget {
  final Uint8List? imageBytes;
  final String? fileName;
  final VoidCallback onRemove;

  const _AttachmentPreview({
    this.imageBytes,
    this.fileName,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          if (imageBytes != null)
            Stack(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Image.memory(
                    imageBytes!,
                    width: 80,
                    height: 80,
                    fit: BoxFit.cover,
                  ),
                ),
                Positioned(
                  top: 0,
                  right: 0,
                  child: GestureDetector(
                    onTap: onRemove,
                    child: Container(
                      padding: const EdgeInsets.all(2),
                      decoration: const BoxDecoration(
                        color: Colors.black54,
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.close,
                        size: 16,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ],
            )
          else if (fileName != null)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.insert_drive_file, size: 24),
                  const SizedBox(width: 8),
                  Text(
                    fileName!,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(width: 8),
                  GestureDetector(
                    onTap: onRemove,
                    child: const Icon(Icons.close, size: 16),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
