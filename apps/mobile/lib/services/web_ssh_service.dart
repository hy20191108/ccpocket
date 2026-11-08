import 'dart:convert';

import 'package:http/http.dart' as http;

/// The local web server owns OpenSSH; browser storage stays destination-specific.
class WebSshService {
  final Uri base;
  final http.Client? client;

  WebSshService({Uri? base, this.client}) : base = base ?? Uri.base;

  bool get isLocalLauncher =>
      base.scheme == 'http' &&
      (base.host == 'ccpocket.localhost' ||
          RegExp(r'^ccp-[a-f0-9]{32}\.localhost$').hasMatch(base.host));

  Uri get _endpoint =>
      base.replace(path: '/__ccpocket/ssh', query: null, fragment: null);

  Future<Map<String, dynamic>?> info() async {
    if (!isLocalLauncher) return null;
    try {
      final response = await (client?.get(_endpoint) ?? http.get(_endpoint))
          .timeout(const Duration(seconds: 3));
      if (response.statusCode != 200) return null;
      final value = jsonDecode(response.body);
      return value is Map<String, dynamic> && value['available'] == true
          ? value
          : null;
    } catch (_) {
      return null;
    }
  }

  Future<Uri> connect(String alias, int remotePort) async {
    if (!isLocalLauncher ||
        !RegExp(r'^[A-Za-z0-9_][A-Za-z0-9_.-]*$').hasMatch(alias) ||
        remotePort < 1 ||
        remotePort > 65535) {
      throw const FormatException('Invalid SSH destination');
    }
    final headers = {'Content-Type': 'application/json'};
    final body = jsonEncode({'alias': alias, 'remotePort': remotePort});
    final response =
        await (client?.post(_endpoint, headers: headers, body: body) ??
                http.post(_endpoint, headers: headers, body: body))
            .timeout(const Duration(seconds: 30));
    if (response.statusCode != 200) throw StateError('SSH connection failed');
    final url = Uri.parse(jsonDecode(response.body)['url'] as String);
    if (url.scheme != 'http' ||
        url.port != base.port ||
        !RegExp(r'^ccp-[a-f0-9]{32}\.localhost$').hasMatch(url.host) ||
        url.userInfo.isNotEmpty ||
        url.path != '/' ||
        url.hasQuery ||
        url.hasFragment) {
      throw const FormatException('Invalid local SSH connection URL');
    }
    return url;
  }
}
