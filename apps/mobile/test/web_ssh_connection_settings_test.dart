import 'dart:convert';

import 'package:ccpocket/features/session_list/widgets/web_ssh_connection_settings.dart';
import 'package:ccpocket/l10n/app_localizations.dart';
import 'package:ccpocket/services/web_ssh_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets(
    'chooses an SSH destination in the machine settings and opens its dedicated origin',
    (tester) async {
      Uri? opened;
      final target = 'http://ccp-${'a' * 32}.localhost:8889/';
      final service = WebSshService(
        base: Uri.parse('http://ccpocket.localhost:8889/'),
        client: MockClient((request) async {
            if (request.method == 'GET') {
            return http.Response('{"available":true}', 200);
            }
          expect(jsonDecode(request.body), {
            'alias': 'host-alias',
            'remotePort': 8767,
          });
          return http.Response(jsonEncode({'url': target}), 200);
        }),
      );
      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('ja'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: WebSshConnectionSettings(
              service: service,
              open: (url) async {
                opened = url;
                return true;
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('web_ssh_alias_field')),
        'host-alias',
      );
      await tester.enterText(
        find.byKey(const ValueKey('web_ssh_bridge_port_field')),
        '8767',
      );
      expect(find.text('SSHで接続'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('web_ssh_connect_button')));
      await tester.pumpAndSettle();
      expect(opened, Uri.parse(target));
    },
  );
}
