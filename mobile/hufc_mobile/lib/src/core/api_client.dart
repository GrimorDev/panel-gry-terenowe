import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

class ApiClient {
  ApiClient({String? baseUrl}) : baseUrl = (baseUrl ?? const String.fromEnvironment('API_URL', defaultValue: 'https://vipile.com')).replaceAll(RegExp(r'/$'), '');

  final String baseUrl;

  Future<AuthSession> login(String email, String password) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email, 'password': password}),
    );
    final json = _decode(response);
    if (json['ok'] != true) throw ApiException(jsonString(json['error'], fallback: 'Nie udało się zalogować'));
    return AuthSession(
      token: jsonString(json['token']),
      user: AppUser.fromJson(json['user'] as Map<String, dynamic>),
    );
  }

  Future<AppState> state(String token, {int? gameId}) async {
    final uri = Uri.parse('$baseUrl/api/state').replace(queryParameters: gameId == null ? null : {'gameId': '$gameId'});
    final response = await http.get(uri, headers: _headers(token));
    final json = _decode(response);
    if (json['ok'] == false) throw ApiException(jsonString(json['error'], fallback: 'Nie udało się pobrać danych'));
    return AppState.fromJson(json);
  }

  Future<AppState> postState(String token, String url, Map<String, dynamic> body) async {
    final response = await http.post(
      Uri.parse('$baseUrl$url'),
      headers: _headers(token),
      body: jsonEncode(body),
    );
    final json = _decode(response);
    if (json['ok'] == false) throw ApiException(jsonString(json['error'], fallback: 'Nie udało się zapisać zmian'));
    return AppState.fromJson(json);
  }

  Future<AppState> deleteState(String token, String url) async {
    final response = await http.delete(Uri.parse('$baseUrl$url'), headers: _headers(token));
    final json = _decode(response);
    if (json['ok'] == false) throw ApiException(jsonString(json['error'], fallback: 'Nie udało się usunąć'));
    return AppState.fromJson(json);
  }

  Map<String, String> _headers(String token) => {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      };

  Map<String, dynamic> _decode(http.Response response) {
    if (response.statusCode >= 500) throw ApiException('Serwer chwilowo nie odpowiada');
    if (response.body.isEmpty) throw ApiException('Pusta odpowiedź serwera');
    final json = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode >= 400) throw ApiException(jsonString(json['error'], fallback: 'Błąd połączenia'));
    return json;
  }
}

class ApiException implements Exception {
  ApiException(this.message);
  final String message;
  @override
  String toString() => message;
}
