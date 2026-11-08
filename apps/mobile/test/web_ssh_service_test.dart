import 'dart:convert';

import 'package:ccpocket/services/web_ssh_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  final base = Uri.parse('http://ccpocket.localhost:8889/');
  test(
    'connects through the local endpoint without sending Bridge credentials',
    () async {
      final target = 'http://ccp-${'a' * 32}.localhost:8889/';
      final service = WebSshService(
        base: base,
        client: MockClient((request) async {
          expect(request.url.path, '/__ccpocket/ssh');
          expect(jsonDecode(request.body), {
            'alias': 'host-alias',
            'remotePort': 8765,
          });
          expect(request.headers.containsKey('authorization'), isFalse);
          return http.Response(jsonEncode({'url': target}), 200);
        }),
      );
      expect(await service.connect('host-alias', 8765), Uri.parse(target));
    },
  );
  test('rejects an external redirect or a different local port', () async {
    for (final target in [
      'https://example.com/',
      'http://ccp-${'a' * 32}.localhost:9999/',
    ]) {
      final service = WebSshService(
        base: base,
        client: MockClient(
          (_) async => http.Response(jsonEncode({'url': target}), 200),
        ),
      );
      await expectLater(
        service.connect('host-alias', 8765),
        throwsFormatException,
      );
    }
  });
  test('does not call SSH setup APIs from a remotely hosted web app', () async {
    final service = WebSshService(
      base: Uri.parse('https://example.com/'),
      client: MockClient((_) async => throw StateError('must not request')),
    );
    expect(await service.info(), isNull);
    await expectLater(
      service.connect('host-alias', 8765),
      throwsFormatException,
    );
  });
}
