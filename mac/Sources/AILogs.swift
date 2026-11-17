// AI 대화 기록 감시: Claude Code(~/.claude/projects)·Codex(~/.codex/sessions)의 *.jsonl 이 바뀌면
// 그 파일 끝에서 "시각(timestamp)이 찍힌 마지막 줄"을 읽어 둠. 판정은 logic.js 의 logWorking 이 함.
//  - 관리용 줄(cost-state, mode, ai-title …)에는 시각이 없어서 저절로 빠짐 → 앱이 켜져만 있어도 생기는 쓰기는 무시
//  - FSEvents 로 바뀐 파일만 읽으므로 가벼움 (기록 폴더가 수 GB여도 상관없음)
import Foundation
import CoreServices

final class AILogs {
    private struct Root { let key: String; let dirs: [URL] }
    private let roots: [Root]
    private let queue = DispatchQueue(label: "aiwatchdog.ailogs", qos: .utility)
    private var entries: [String: [String: [String: Any]]] = [:]     // key → 파일 경로 → 마지막 줄 요약
    private var stream: FSEventStreamRef?
    private static let keep: TimeInterval = 40 * 60                     // 이보다 오래된 줄은 버림

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        var claude = [home.appendingPathComponent(".claude/projects"), home.appendingPathComponent(".config/claude/projects")]
        if let env = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !env.isEmpty {
            claude.append(URL(fileURLWithPath: env).appendingPathComponent("projects"))
        }
        let all = [Root(key: "claude", dirs: claude), Root(key: "codex", dirs: [home.appendingPathComponent(".codex/sessions")])]
        let fm = FileManager.default
        roots = all.compactMap { r in
            let found = r.dirs.filter { fm.fileExists(atPath: $0.path) }
            return found.isEmpty ? nil : Root(key: r.key, dirs: found)
        }
        for r in roots { entries[r.key] = [:] }
        queue.async { self.seed() }
        start()
    }

    deinit {
        if let s = stream { FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s) }
    }

    /// {key: [{t, type, sub, stop, tool}]} — 기록 폴더가 있는 앱만 들어감 (없으면 그 앱은 CPU 로 판정)
    func snapshot() -> [String: Any] {
        queue.sync {
            let now = Date().timeIntervalSince1970
            var out: [String: Any] = [:]
            for (key, files) in entries {
                out[key] = files.values.filter { now - (($0["t"] as? Double) ?? 0) < Self.keep }
            }
            return out
        }
    }

    // ---------------------------------------------------------------- 처음: 최근 40분 안에 바뀐 파일만 읽음
    private func seed() {
        let fm = FileManager.default
        let cutoff = Date().addingTimeInterval(-Self.keep)
        for r in roots {
            for dir in r.dirs {
                guard let walker = fm.enumerator(at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]) else { continue }
                for case let url as URL in walker where url.pathExtension == "jsonl" {
                    let m = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                    if m > cutoff { read(url.path, key: r.key) }
                }
            }
        }
    }

    // ---------------------------------------------------------------- 파일 변경 알림
    private func start() {
        let paths = roots.flatMap { $0.dirs.map { $0.path } }
        guard !paths.isEmpty else { return }
        var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let cb: FSEventStreamCallback = { _, info, count, rawPaths, _, _ in
            guard let info else { return }
            let me = Unmanaged<AILogs>.fromOpaque(info).takeUnretainedValue()
            let list = unsafeBitCast(rawPaths, to: NSArray.self) as? [String] ?? []
            for p in list.prefix(count) where p.hasSuffix(".jsonl") { me.changed(p) }
        }
        let flags = UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer)
        guard let s = FSEventStreamCreate(nil, cb, &ctx, paths as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.5, flags) else { return }
        FSEventStreamSetDispatchQueue(s, queue)
        FSEventStreamStart(s)
        stream = s
    }

    private func changed(_ path: String) {      // queue 위에서 불림
        guard let r = roots.first(where: { r in r.dirs.contains { path.hasPrefix($0.path) } }) else { return }
        read(path, key: r.key)
    }

    // ---------------------------------------------------------------- 파일 끝에서 시각이 찍힌 마지막 줄 찾기
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let isoPlain = ISO8601DateFormatter()
    private static let tag = Data("\"timestamp\"".utf8)

    private func read(_ path: String, key: String) {
        guard let h = FileHandle(forReadingAtPath: path) else { entries[key]?[path] = nil; return }
        defer { try? h.close() }
        let size = (try? h.seekToEnd()) ?? 0
        let chunk: UInt64 = 512 * 1024
        let start = size > chunk ? size - chunk : 0
        try? h.seek(toOffset: start)
        guard let data = try? h.readToEnd(), !data.isEmpty else { return }
        var lines = data.split(separator: 0x0A, omittingEmptySubsequences: true)
        if start > 0, !lines.isEmpty { lines.removeFirst() }          // 잘린 첫 줄
        for line in lines.reversed() where line.range(of: Self.tag) != nil {
            guard let o = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  let ts = o["timestamp"] as? String,
                  let d = Self.iso.date(from: ts) ?? Self.isoPlain.date(from: ts) else { continue }
            entries[key]?[path] = Self.summary(o, t: d.timeIntervalSince1970)
            return
        }
    }

    private static func summary(_ o: [String: Any], t: Double) -> [String: Any] {
        let msg = o["message"] as? [String: Any]
        let payload = o["payload"] as? [String: Any]                          // Codex
        let content = msg?["content"] as? [[String: Any]] ?? []
        let ptype = payload?["type"] as? String
        let tool = content.contains { ($0["type"] as? String) == "tool_use" } || ptype == "function_call" || ptype == "local_shell_call"
        var e: [String: Any] = ["t": t, "type": o["type"] as? String ?? "", "tool": tool]
        if let sub = (o["subtype"] as? String) ?? ptype ?? (o["operation"] as? String) { e["sub"] = sub }
        if let stop = msg?["stop_reason"] as? String { e["stop"] = stop }
        return e
    }
}
