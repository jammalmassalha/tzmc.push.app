/// Data models for the Accreditation AI Agent feature.
library;

/// A single PDF file returned by the accreditation agent.
class AccreditationFile {
  final String name;
  final String url;

  const AccreditationFile({required this.name, required this.url});

  factory AccreditationFile.fromJson(Map<String, dynamic> json) {
    return AccreditationFile(
      name: json['name']?.toString() ?? '',
      url: json['url']?.toString() ?? '',
    );
  }
}

/// Response from the `/accreditation/ask` endpoint.
class AccreditationAgentResponse {
  final String answer;
  final List<AccreditationFile> relevantFiles;

  const AccreditationAgentResponse({
    required this.answer,
    required this.relevantFiles,
  });

  factory AccreditationAgentResponse.fromJson(Map<String, dynamic> json) {
    final rawFiles = json['relevantFiles'];
    final files = rawFiles is List
        ? rawFiles
            .whereType<Map>()
            .map((e) => AccreditationFile.fromJson(
                  e.map((k, v) => MapEntry(k.toString(), v)),
                ))
            .toList()
        : <AccreditationFile>[];
    return AccreditationAgentResponse(
      answer: json['answer']?.toString() ?? '',
      relevantFiles: files,
    );
  }
}
