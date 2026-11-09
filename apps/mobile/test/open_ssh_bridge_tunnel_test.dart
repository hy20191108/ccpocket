import 'dart:io';

import 'package:ccpocket/services/open_ssh_bridge_tunnel.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'uses strict OpenSSH stdio forwarding and rejects SSH option injection',
    () {
      final arguments = openSshBridgeArguments('host-alias', 8765);
      expect(arguments, contains('StrictHostKeyChecking=yes'));
      expect(arguments, contains('ControlPath=none'));
      expect(arguments, contains('ForkAfterAuthentication=no'));
      expect(arguments, contains('StdinNull=no'));
      expect(
        arguments,
        containsAllInOrder(['-W', '127.0.0.1:8765', '--', 'host-alias']),
      );
      expect(arguments, isNot(contains('-L')));
      expect(
        () => openSshBridgeArguments('-oProxyCommand=bad', 8765),
        throwsFormatException,
      );
      expect(
        () => openSshBridgeArguments('host-alias', 65536),
        throwsFormatException,
      );
    },
  );

  test('rejects browser requests before opening an SSH connection', () async {
    final tunnel = await OpenSshBridgeTunnel.start(
      signature: 'test',
      alias: 'unused-host.invalid',
      remotePort: 8765,
    );
    final client = HttpClient();
    addTearDown(() async {
      client.close(force: true);
      await tunnel.close();
    });
    final request = await client.getUrl(
      Uri.parse('http://127.0.0.1:${tunnel.localPort}/health'),
    );
    request.headers.set('Origin', 'https://example.com');
    final response = await request.close();
    expect(response.statusCode, HttpStatus.forbidden);
    await response.drain<void>();
  });
}
