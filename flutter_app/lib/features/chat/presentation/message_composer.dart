/// Message composer widget - text input for sending messages.
///
/// Supports text input, image/file attachments, and editing mode.
/// Works on both native and web platforms using XFile abstraction.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/api/chat_api_service.dart';
import '../../../core/models/chat_models.dart';
import '../../../core/services/chat_store_service.dart';
import '../../../core/utils/xfile.dart' as xfile;
import '../../../shared/theme/app_theme.dart';

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
    return SafeArea(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          border: Border(
            top: BorderSide(
              color: Theme.of(context).dividerColor,
              width: 0.5,
            ),
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Attachment preview
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

            // Input row
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                // Attachment button
                IconButton(
                  icon: const Icon(Icons.attach_file),
                  onPressed: _showAttachmentOptions,
                  tooltip: 'צרף קובץ',
                ),

                // Text input
                Expanded(
                  child: Container(
                    constraints: const BoxConstraints(maxHeight: 120),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(24),
                    ),
                    child: TextField(
                      controller: _textController,
                      focusNode: _focusNode,
                      maxLines: null,
                      keyboardType: TextInputType.multiline,
                      textInputAction: TextInputAction.newline,
                      textDirection: TextDirection.rtl,
                      decoration: InputDecoration(
                        hintText: 'הקלד הודעה...',
                        hintTextDirection: TextDirection.rtl,
                        border: InputBorder.none,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 10,
                        ),
                      ),
                      onSubmitted: (_) => _handleSend(),
                    ),
                  ),
                ),

                const SizedBox(width: 8),

                // Send button
                _isSending
                    ? const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox(
                          width: 24,
                          height: 24,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : IconButton(
                        icon: Icon(
                          widget.editingMessage != null ? Icons.check : Icons.send,
                          color: AppColors.primary,
                        ),
                        onPressed: _handleSend,
                        tooltip: widget.editingMessage != null ? 'שמור' : 'שלח',
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
          ],
        ),
      ),
    );
  }

  Future<void> _pickImage(ImageSource source) async {
    // On web, camera is not supported
    if (kIsWeb && source == ImageSource.camera) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('צילום לא נתמך בדפדפן')),
      );
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
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('בחירת קובץ - בקרוב')),
    );
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

    final messenger = ScaffoldMessenger.of(context);
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
        messenger.showSnackBar(
          SnackBar(
            content: Text('שגיאה בשליחה: ${e.toString()}'),
            backgroundColor: errorColor,
          ),
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
