import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';

class ApiClient {
  ApiClient({String? baseUrl}) : baseUrl = normalizeBaseUrl(baseUrl ?? defaultBaseUrl);

  static const defaultBaseUrl = String.fromEnvironment('API_URL', defaultValue: 'https://vipile.com');

  String baseUrl;

  static String normalizeBaseUrl(String value) {
    final trimmed = value.trim().replaceAll(RegExp(r'/$'), '');
    if (trimmed.isEmpty) return defaultBaseUrl;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    return 'https://$trimmed';
  }

  void setBaseUrl(String value) {
    baseUrl = normalizeBaseUrl(value);
  }

  Future<AuthSession> login(String email, String password) async {
    final response = await _send(
      () => http.post(
        Uri.parse('$baseUrl/api/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'email': email, 'password': password}),
      ),
    );
    final json = _decode(response);
    if (json['ok'] != true) {
      throw ApiException(jsonString(json['error'], fallback: 'Nie udało się zalogować'));
    }
    return AuthSession(
      token: jsonString(json['token']),
      user: AppUser.fromJson(json['user'] as Map<String, dynamic>),
    );
  }

  Future<AppState> state(String token, {int? gameId}) async {
    final uri = Uri.parse('$baseUrl/api/state').replace(queryParameters: {
      'mobile': '1',
      if (gameId != null) 'gameId': '$gameId',
    });
    final response = await _send(() => http.get(uri, headers: _headers(token)));
    final json = _decode(response);
    if (json['ok'] == false) {
      throw ApiException(jsonString(json['error'], fallback: 'Nie udało się pobrać danych'));
    }
    return AppState.fromJson(json);
  }

  Future<AppState> postState(String token, String url, Map<String, dynamic> body) async {
    final response = await _send(
      () => http.post(
        _mobileUri(url),
        headers: _headers(token),
        body: jsonEncode(body),
      ),
    );
    final json = _decode(response);
    if (json['ok'] == false) {
      throw ApiException(jsonString(json['error'], fallback: 'Nie udało się zapisać zmian'));
    }
    return AppState.fromJson(json);
  }

  Future<AppState> deleteState(String token, String url) async {
    final response = await _send(() => http.delete(_mobileUri(url), headers: _headers(token)));
    final json = _decode(response);
    if (json['ok'] == false) {
      throw ApiException(jsonString(json['error'], fallback: 'Nie udało się usunąć'));
    }
    return AppState.fromJson(json);
  }

  Map<String, String> _headers(String token) => {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
        'X-Hufc-Mobile': '1',
      };

  Uri _mobileUri(String url) {
    final uri = Uri.parse('$baseUrl$url');
    return uri.replace(queryParameters: {
      ...uri.queryParameters,
      'mobile': '1',
    });
  }

  Future<http.Response> _send(Future<http.Response> Function() request) async {
    try {
      return await request().timeout(const Duration(seconds: 14));
    } on SocketException {
      throw ApiException('Nie mogę połączyć się z serwerem. Sprawdź internet i adres serwera: $baseUrl');
    } on TimeoutException {
      throw ApiException('Serwer odpowiada za długo. Spróbuj ponownie albo sprawdź zasięg.');
    } on http.ClientException {
      throw ApiException('Nie udało się połączyć z serwerem: $baseUrl');
    } on FormatException {
      throw ApiException('Serwer zwrócił nieprawidłową odpowiedź.');
    }
  }

  Map<String, dynamic> _decode(http.Response response) {
    if (response.statusCode >= 500) throw ApiException('Serwer chwilowo nie odpowiada');
    if (response.body.isEmpty) throw ApiException('Pusta odpowiedź serwera');
    late final Map<String, dynamic> json;
    try {
      json = jsonDecode(response.body) as Map<String, dynamic>;
    } on FormatException {
      if (response.statusCode >= 400) {
        throw ApiException('Serwer odrzucił żądanie. Sprawdź adres API i dane logowania.');
      }
      throw ApiException('Serwer zwrócił nieprawidłową odpowiedź.');
    }
    if (response.statusCode >= 400) {
      throw ApiException(jsonString(json['error'], fallback: 'Błąd połączenia'));
    }
    return json;
  }
}

class ApiException implements Exception {
  ApiException(this.message);
  final String message;
  @override
  String toString() => message;
}
