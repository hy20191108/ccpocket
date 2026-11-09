import 'dart:async';
import 'dart:convert';
import 'dart:io';

abstract interface class ManagedBridgeTunnel {
  String get signature;
  int get localPort;
  Future<void> close();
}

List<String> openSshBridgeArguments(String alias, int remotePort) {
  if (!RegExp(r'^[A-Za-z0-9_][A-Za-z0-9_.-]*$').hasMatch(alias) ||
      remotePort < 1 ||
      remotePort > 65535) {
    throw const FormatException('Invalid OpenSSH destination');
  }
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'NoHostAuthenticationForLocalhost=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ForkAfterAuthentication=no',
    '-o',
    'StdinNull=no',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-W',
    '127.0.0.1:$remotePort',
    '--',
    alias,
  ];
}

/// A loopback listener owned by the app. Each accepted connection travels over
/// the SSH process's streams, never through a separately allocated SSH listener.
class OpenSshBridgeTunnel implements ManagedBridgeTunnel {
  @override
  final String signature;
  final ServerSocket _server;
  final List<String> _arguments;
  final Set<Socket> _sockets = {};
  final Set<Process> _processes = {};
  final Set<Future<void>> _forwards = {};
  late final StreamSubscription<Socket> _subscription;
  bool _closed = false;

  OpenSshBridgeTunnel._(this.signature, this._server, this._arguments) {
    _subscription = _server.listen((socket) {
      final forward = _forward(socket);
      _forwards.add(forward);
      unawaited(
        forward.then<void>(
          (_) {
            _forwards.remove(forward);
          },
          onError: (Object error, StackTrace stackTrace) {
            _forwards.remove(forward);
          },
        ),
      );
    });
  }

  static Future<OpenSshBridgeTunnel> start({
    required String signature,
    required String alias,
    required int remotePort,
  }) async {
    final arguments = openSshBridgeArguments(alias, remotePort);
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    return OpenSshBridgeTunnel._(signature, server, arguments);
  }

  @override
  int get localPort => _server.port;

  Future<void> _forward(Socket socket) async {
    _sockets.add(socket);
    Process? process;
    try {
      final iterator = StreamIterator<List<int>>(socket);
      final header = <int>[];
      var complete = false;
      while (!complete &&
          await iterator.moveNext().timeout(const Duration(seconds: 10))) {
        header.addAll(iterator.current);
        complete = latin1.decode(header).contains('\r\n\r\n');
        if (!complete && header.length > 65536) {
          throw const FormatException('Request header too large');
        }
      }
      if (!complete || _closed) return;
      final text = latin1.decode(header);
      final end = text.indexOf('\r\n\r\n');
      if (end > 65536) throw const FormatException('Request header too large');
      // Native HTTP/WS clients do not send browser fetch metadata. Do not let
      // an unrelated web page use the desktop app as an authenticated SSH proxy.
      if (RegExp(
        r'\r\n(?:origin|sec-fetch-[^:]*):',
        caseSensitive: false,
      ).hasMatch(text.substring(0, end))) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        await socket.flush();
        return;
      }
      process = await Process.start('ssh', _arguments);
      if (_closed) {
        process.kill();
        return;
      }
      _processes.add(process);
      unawaited(process.stderr.drain<void>());
      process.stdin.add(header);
      await process.stdin.flush();
      final outbound = () async {
        while (await iterator.moveNext()) {
          process!.stdin.add(iterator.current);
          await process.stdin.flush();
        }
        await process!.stdin.close();
      }();
      final inbound = () async {
        await socket.addStream(process!.stdout);
        await socket.flush();
        socket.destroy();
      }();
      await Future.wait([outbound, inbound]);
    } catch (_) {
      // The HTTP/WS client reports connection failure. SSH diagnostics may
      // contain private host configuration, so keep them out of chat/log data.
    } finally {
      socket.destroy();
      _sockets.remove(socket);
      if (process != null) {
        process.kill();
        await process.exitCode;
        _processes.remove(process);
      }
    }
  }

  @override
  Future<void> close() async {
    _closed = true;
    await _subscription.cancel();
    await _server.close();
    for (final socket in _sockets.toList()) {
      socket.destroy();
    }
    for (final process in _processes.toList()) {
      process.kill();
    }
    await Future.wait(_forwards.toList());
  }
}
