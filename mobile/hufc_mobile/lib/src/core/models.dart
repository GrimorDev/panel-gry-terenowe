import 'dart:convert';

class AuthSession {
  const AuthSession({required this.token, required this.user});

  final String token;
  final AppUser user;

  Map<String, dynamic> toJson() => {
        'token': token,
        'user': user.toJson(),
      };

  factory AuthSession.fromJson(Map<String, dynamic> json) => AuthSession(
        token: json['token'] as String,
        user: AppUser.fromJson(json['user'] as Map<String, dynamic>),
      );
}

class AppUser {
  const AppUser({required this.id, required this.email, required this.name, required this.role});

  final int id;
  final String email;
  final String name;
  final String role;

  bool get isAdmin => role == 'administrator';

  Map<String, dynamic> toJson() => {
        'id': id,
        'email': email,
        'name': name,
        'role': role,
      };

  factory AppUser.fromJson(Map<String, dynamic> json) => AppUser(
        id: jsonInt(json['id']),
        email: jsonString(json['email']),
        name: jsonString(json['name']),
        role: jsonString(json['role']),
      );
}

class AppState {
  const AppState({
    required this.raw,
    required this.games,
    required this.teams,
    required this.stations,
    required this.scores,
    required this.tents,
    required this.members,
    required this.points,
  });

  final Map<String, dynamic> raw;
  final List<Game> games;
  final List<Team> teams;
  final List<Station> stations;
  final List<Score> scores;
  final List<Tent> tents;
  final List<TentMember> members;
  final List<CompetitionPoint> points;

  Game get game => Game.fromJson(raw['game'] as Map<String, dynamic>);

  AppState copyWithRaw(Map<String, dynamic> nextRaw) => AppState.fromJson(nextRaw);

  factory AppState.fromJson(Map<String, dynamic> json) => AppState(
        raw: json,
        games: jsonList(json['games']).map((item) => Game.fromJson(item)).toList(),
        teams: jsonList(json['teams']).map((item) => Team.fromJson(item)).toList(),
        stations: jsonList(json['stations']).map((item) => Station.fromJson(item)).toList(),
        scores: jsonList(json['scores']).map((item) => Score.fromJson(item)).toList(),
        tents: jsonList(json['competition_tents']).map((item) => Tent.fromJson(item)).toList(),
        members: jsonList(json['competition_members']).map((item) => TentMember.fromJson(item)).toList(),
        points: jsonList(json['competition_points']).map((item) => CompetitionPoint.fromJson(item)).toList(),
      );

  String encode() => jsonEncode(raw);
}

class Game {
  const Game({
    required this.id,
    required this.name,
    required this.durationMinutes,
    required this.remainingSeconds,
    required this.timerRunning,
    required this.timerUpdatedAt,
  });

  final int id;
  final String name;
  final int durationMinutes;
  final int remainingSeconds;
  final bool timerRunning;
  final DateTime timerUpdatedAt;

  factory Game.fromJson(Map<String, dynamic> json) => Game(
        id: jsonInt(json['id']),
        name: jsonString(json['name'], fallback: 'Gra'),
        durationMinutes: jsonInt(json['duration_minutes'], fallback: 90),
        remainingSeconds: jsonInt(json['remaining_seconds'], fallback: 5400),
        timerRunning: json['timer_running'] == true,
        timerUpdatedAt: DateTime.tryParse(jsonString(json['timer_updated_at'])) ?? DateTime.now(),
      );
}

class Team {
  const Team({required this.id, required this.gameId, required this.name, required this.color, required this.totalPoints});

  final int id;
  final int gameId;
  final String name;
  final String color;
  final int totalPoints;

  factory Team.fromJson(Map<String, dynamic> json) => Team(
        id: jsonInt(json['id']),
        gameId: jsonInt(json['game_id']),
        name: jsonString(json['name'], fallback: 'Drużyna'),
        color: jsonString(json['color'], fallback: '#1F4D2E'),
        totalPoints: jsonInt(json['total_points']),
      );
}

class Station {
  const Station({required this.id, required this.gameId, required this.title, required this.order});

  final int id;
  final int gameId;
  final String title;
  final int order;

  factory Station.fromJson(Map<String, dynamic> json) => Station(
        id: jsonInt(json['id']),
        gameId: jsonInt(json['game_id']),
        title: jsonString(json['title'], fallback: 'Stacja'),
        order: jsonInt(json['station_order']),
      );
}

class Score {
  const Score({required this.teamId, required this.stationId, required this.points, required this.finished});

  final int teamId;
  final int stationId;
  final int points;
  final bool finished;

  factory Score.fromJson(Map<String, dynamic> json) => Score(
        teamId: jsonInt(json['team_id']),
        stationId: jsonInt(json['station_id']),
        points: jsonInt(json['points']),
        finished: json['finished_at'] != null,
      );
}

class Tent {
  const Tent({required this.id, required this.name, required this.color, required this.totalPoints, required this.memberCount});

  final int id;
  final String name;
  final String color;
  final int totalPoints;
  final int memberCount;

  factory Tent.fromJson(Map<String, dynamic> json) => Tent(
        id: jsonInt(json['id']),
        name: jsonString(json['name'], fallback: 'Namiot'),
        color: jsonString(json['color'], fallback: '#1F4D2E'),
        totalPoints: jsonInt(json['total_points']),
        memberCount: jsonInt(json['member_count']),
      );
}

class TentMember {
  const TentMember({required this.tentId, required this.wardId, required this.name});

  final int tentId;
  final int wardId;
  final String name;

  factory TentMember.fromJson(Map<String, dynamic> json) => TentMember(
        tentId: jsonInt(json['tent_id']),
        wardId: jsonInt(json['ward_id']),
        name: jsonString(json['ward_name'], fallback: 'Podopieczny'),
      );
}

class CompetitionPoint {
  const CompetitionPoint({
    required this.id,
    required this.tentId,
    required this.tentName,
    required this.category,
    required this.points,
    required this.reason,
    required this.createdAt,
    this.previousPoints,
    this.edited = false,
    this.editedAt,
  });

  final int id;
  final int tentId;
  final String tentName;
  final String category;
  final int points;
  final String reason;
  final String createdAt;
  final int? previousPoints;
  final bool edited;
  final String? editedAt;

  factory CompetitionPoint.fromJson(Map<String, dynamic> json) => CompetitionPoint(
        id: jsonInt(json['id']),
        tentId: jsonInt(json['tent_id']),
        tentName: jsonString(json['tent_name'], fallback: 'Namiot'),
        category: jsonString(json['category'], fallback: 'Punkty'),
        points: jsonInt(json['points']),
        reason: jsonString(json['reason']),
        createdAt: jsonString(json['created_at']),
        previousPoints: json['previous_points'] == null ? null : jsonInt(json['previous_points']),
        edited: json['edited_at'] != null,
        editedAt: json['edited_at'] == null ? null : jsonString(json['edited_at']),
      );
}

int jsonInt(Object? value, {int fallback = 0}) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  return int.tryParse('$value') ?? fallback;
}

String jsonString(Object? value, {String fallback = ''}) {
  final text = value?.toString() ?? '';
  return text.isEmpty ? fallback : text;
}

List<Map<String, dynamic>> jsonList(Object? value) {
  if (value is List) {
    return value.whereType<Map>().map((item) => Map<String, dynamic>.from(item)).toList();
  }
  return [];
}
