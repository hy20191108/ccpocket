import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../l10n/app_localizations.dart';
import '../../../services/web_ssh_service.dart';

class WebSshConnectionSettings extends StatefulWidget {
  final WebSshService? service;
  final Future<bool> Function(Uri)? open;

  const WebSshConnectionSettings({super.key, this.service, this.open});

  @override
  State<WebSshConnectionSettings> createState() =>
      _WebSshConnectionSettingsState();
}

class _WebSshConnectionSettingsState extends State<WebSshConnectionSettings> {
  final _alias = TextEditingController();
  final _port = TextEditingController(text: '8765');
  late final WebSshService _service;
  bool _available = false;
  bool _loading = true;
  bool _connecting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _service = widget.service ?? WebSshService();
    _load();
  }

  Future<void> _load() async {
    final info = await _service.info();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _available = info != null;
      _alias.text = info?['alias'] as String? ?? '';
      _port.text = (info?['remotePort'] as int? ?? 8765).toString();
    });
  }

  @override
  void dispose() {
    _alias.dispose();
    _port.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final l = AppLocalizations.of(context);
    final alias = _alias.text.trim();
    final port = int.tryParse(_port.text);
    if (!RegExp(r'^[A-Za-z0-9_][A-Za-z0-9_.-]*$').hasMatch(alias) ||
        port == null ||
        port < 1 ||
        port > 65535) {
      setState(() => _error = l.webSshInvalidDestination);
      return;
    }
    setState(() {
      _connecting = true;
      _error = null;
    });
    try {
      final url = await _service.connect(alias, port);
      final opened = widget.open != null
          ? await widget.open!(url)
          : await launchUrl(url, webOnlyWindowName: '_self');
      if (!opened) throw StateError('Could not open SSH connection');
    } catch (_) {
      if (mounted) setState(() => _error = l.webSshConnectionFailed);
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    if (_loading) return const LinearProgressIndicator();
    if (!_available) return Text(l.webSshLocalAppRequired);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(l.webSshDescription),
        const SizedBox(height: 12),
        TextField(
          key: const ValueKey('web_ssh_alias_field'),
          controller: _alias,
          enabled: !_connecting,
          decoration: InputDecoration(
            labelText: l.webSshAlias,
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          key: const ValueKey('web_ssh_bridge_port_field'),
          controller: _port,
          enabled: !_connecting,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(
            labelText: l.webSshBridgePort,
            border: const OutlineInputBorder(),
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(
            _error!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        ],
        const SizedBox(height: 12),
        FilledButton.icon(
          key: const ValueKey('web_ssh_connect_button'),
          onPressed: _connecting ? null : _connect,
          icon: _connecting
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.lock_outline),
          label: Text(l.webSshConnect),
        ),
      ],
    );
  }
}
