// Claude Code 기록(~/.claude/projects/**/*.jsonl)에서 날짜·모델별 토큰 수를 셈.
// 같은 응답이 여러 줄(내용 블록마다)·여러 파일(이어하기)에 다시 적히므로 message.id + requestId 로 한 번만 셈.
// 파일은 크기·수정 시각이 바뀐 것만 다시 읽음 (메모리 캐시).
import Foundation

final class TokenScanner {
    private struct Entry { let key: String; let day: String; let model: String; let n: [Int] }   // in, out, c5, c1, cr
    private struct Cached { let size: Int; let mtime: Date; let entries: [Entry] }

    private let queue = DispatchQueue(label: "aiwatchdog.tokens", qos: .utility)
    private var cache: [String: Cached] = [:]
    private var busy = false
    private var waiting: [([[String: Any]]) -> Void] = []

    private var roots: [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        var dirs = [home.appendingPathComponent(".claude/projects"), home.appendingPathComponent(".config/claude/projects")]
        if let env = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !env.isEmpty {
            dirs.append(URL(fileURLWithPath: env).appendingPathComponent("projects"))
        }
        return dirs.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// 백그라운드에서 훑고, 끝나면 메인 스레드에서 rows 를 돌려줌
    func scan(_ done: @escaping ([[String: Any]]) -> Void) {
        queue.async {
            self.waiting.append(done)
            guard !self.busy else { return }
            self.busy = true
            let rows = self.collect()
            let callbacks = self.waiting
            self.waiting = []; self.busy = false
            DispatchQueue.main.async { callbacks.forEach { $0(rows) } }
        }
    }

    private func collect() -> [[String: Any]] {
        let fm = FileManager.default
        var seenFiles = Set<String>()
        for root in roots {
            guard let walker = fm.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
                                             options: [.skipsHiddenFiles]) else { continue }
            for case let url as URL in walker where url.pathExtension == "jsonl" {
                let path = url.path
                seenFiles.insert(path)
                let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                let size = v?.fileSize ?? 0, mtime = v?.contentModificationDate ?? .distantPast
                if let c = cache[path], c.size == size, c.mtime == mtime { continue }
                cache[path] = Cached(size: size, mtime: mtime, entries: Self.parse(url))
            }
        }
        cache = cache.filter { seenFiles.contains($0.key) }

        // 중복을 빼고 날짜·모델별로 더함
        var seen = Set<String>()
        var sums: [String: [Int]] = [:]
        for c in cache.values {
            for e in c.entries where seen.insert(e.key).inserted {
                let k = e.day + "\u{1}" + e.model
                var s = sums[k] ?? [0, 0, 0, 0, 0]
                for i in 0..<5 { s[i] += e.n[i] }
                sums[k] = s
            }
        }
        return sums.map { k, s in
            let parts = k.components(separatedBy: "\u{1}")
            return ["day": parts[0], "model": parts.count > 1 ? parts[1] : "", "in": s[0], "out": s[1], "c5": s[2], "c1": s[3], "cr": s[4]]
        }
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()
    private static let needle = Data("\"usage\"".utf8)
    private static let idTag = Data("\"id\":\"msg_".utf8)
    private static let requestTag = Data("\"requestId\":\"".utf8)

    private static func find(_ tag: Data, in p: UnsafeRawPointer, _ len: Int) -> UnsafeRawPointer? {
        tag.withUnsafeBytes { t in memmem(p, len, t.baseAddress, t.count).map { UnsafeRawPointer($0) } }
    }

    /// tag 바로 뒤의 문자열 값 (다음 따옴표까지). 없으면 nil
    private static func value(after tag: Data, in p: UnsafeRawPointer, _ len: Int) -> String? {
        guard let hit = find(tag, in: p, len) else { return nil }
        let start = hit + tag.count, rest = len - (start - p)
        guard rest > 0, let q = memchr(start, 0x22, min(rest, 200)) else { return nil }
        return String(decoding: UnsafeRawBufferPointer(start: start, count: UnsafeRawPointer(q) - start), as: UTF8.self)
    }

    private static func dayKey(_ ts: String) -> String? {
        guard let d = iso.date(from: ts) ?? isoPlain.date(from: ts) else { return nil }
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        guard let y = c.year, let m = c.month, let dd = c.day else { return nil }
        return String(format: "%04d-%02d-%02d", y, m, dd)
    }

    private static func parse(_ url: URL) -> [Entry] {
        guard let data = try? Data(contentsOf: url, options: .alwaysMapped), !data.isEmpty else { return [] }
        // "usage" 가 든 줄만 골라냄 (memchr/memmem 으로 빠르게).
        // 같은 응답이 블록마다 다시 적힌 줄은 JSON 을 풀기 전에 건너뜀 (절반 가까이 됨)
        var lines: [Data] = []
        var quick = Set<String>()
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            let total = raw.count
            var off = 0
            while off < total {
                let p = base + off
                let nl = memchr(p, 0x0A, total - off)
                let len = nl.map { UnsafeRawPointer($0) - p } ?? (total - off)
                if len > 20, Self.find(needle, in: p, len) != nil {
                    var fresh = true
                    if let id = Self.value(after: idTag, in: p, len), let rq = Self.value(after: requestTag, in: p, len) {
                        fresh = quick.insert(id + "|" + rq).inserted
                    }
                    if fresh { lines.append(Data(bytes: p, count: len)) }
                }
                off += len + 1
            }
        }
        var out: [Entry] = []
        var local = Set<String>()
        for line in lines {
            guard let o = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  o["type"] as? String == "assistant",
                  let msg = o["message"] as? [String: Any], let u = msg["usage"] as? [String: Any],
                  let model = msg["model"] as? String, !model.hasPrefix("<"),
                  let ts = o["timestamp"] as? String, let day = dayKey(ts) else { continue }
            let key = "\(msg["id"] as? String ?? "")|\(o["requestId"] as? String ?? (o["uuid"] as? String ?? ""))"
            guard local.insert(key).inserted else { continue }
            let num = { (k: String) -> Int in (u[k] as? NSNumber)?.intValue ?? 0 }
            let create = num("cache_creation_input_tokens")
            var c1 = 0
            if let cc = u["cache_creation"] as? [String: Any] { c1 = (cc["ephemeral_1h_input_tokens"] as? NSNumber)?.intValue ?? 0 }
            c1 = min(c1, create)
            out.append(Entry(key: key, day: day, model: model,
                             n: [num("input_tokens"), num("output_tokens"), create - c1, c1, num("cache_read_input_tokens")]))
        }
        return out
    }
}
