// 업데이트: 사용자가 "업데이트 확인"을 누를 때만 GitHub 최신 릴리스를 봄 (자동 확인 없음).
// "지금 업데이트" → DMG 내려받기 → SHA-256 지문 확인 → 열어서 같은 앱·더 새 버전·서명 확인 → 지금 앱 자리에 바꿔 넣기 → 다시 켜기.
// 앱이 직접 내려받은 파일에는 격리 표시(quarantine)가 붙지 않아 "확인되지 않은 개발자" 경고가 다시 뜨지 않음.
import AppKit
import CryptoKit

final class Updater {
    struct Release { let version: String; let page: String; let dmg: URL; let digest: String? }

    /// GitHub API 주소. 확인용으로 바꿀 수 있음: defaults write com.nik.aiwatchdog updateFeed <URL>
    private var feed: URL {
        if let s = UserDefaults.standard.string(forKey: "updateFeed"), let u = URL(string: s) { return u }
        return URL(string: "https://api.github.com/repos/sourcehp/AI_Watchdog/releases/latest")!
    }
    private(set) var found: Release?
    private var busy = false

    static var current: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    /// "mac-v1.1.3" / "1.1.3" → [1, 1, 3]
    static func numbers(_ s: String) -> [Int] {
        let digits = s.drop { !$0.isNumber }
        return digits.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
    }
    static func isNewer(_ a: String, than b: String) -> Bool {
        var x = numbers(a), y = numbers(b)
        while x.count < y.count { x.append(0) }
        while y.count < x.count { y.append(0) }
        return x.lexicographicallyPrecedes(y) == false && x != y
    }

    // ---------------------------------------------------------------- 확인
    func check(_ done: @escaping (_ state: String, _ info: [String: Any]) -> Void) {
        var req = URLRequest(url: feed, timeoutInterval: 20)
        req.setValue("AI-Watchdog-mac", forHTTPHeaderField: "User-Agent")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { data, resp, err in
            let fail = { (msg: String) in DispatchQueue.main.async { done("error", ["message": msg]) } }
            if let err { return fail(err.localizedDescription) }
            guard let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tag = o["tag_name"] as? String, tag.hasPrefix("mac-v") else {
                return fail("HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)")
            }
            let assets = o["assets"] as? [[String: Any]] ?? []
            guard let a = assets.first(where: { ($0["name"] as? String) == "AI-Watchdog-mac.dmg" }),
                  let s = a["browser_download_url"] as? String, let url = URL(string: s) else { return fail("no DMG in release") }
            let version = String(tag.dropFirst("mac-v".count))
            let rel = Release(version: version, page: o["html_url"] as? String ?? "", dmg: url,
                              digest: (a["digest"] as? String).map { $0.replacingOccurrences(of: "sha256:", with: "") })
            DispatchQueue.main.async {
                if Self.isNewer(version, than: Self.current) {
                    self.found = rel
                    done("available", ["version": version, "page": rel.page])
                } else {
                    self.found = nil
                    done("latest", ["version": version])
                }
            }
        }.resume()
    }

    // ---------------------------------------------------------------- 설치
    /// progress: "downloading" → "installing" → (앱이 다시 켜짐) / 실패하면 "error"
    func install(progress: @escaping (_ state: String, _ info: [String: Any]) -> Void, relaunch: @escaping (URL) -> Void) {
        guard let rel = found, !busy else { return }
        let appURL = Bundle.main.bundleURL
        let parent = appURL.deletingLastPathComponent()
        guard FileManager.default.isWritableFile(atPath: parent.path), !appURL.path.hasPrefix("/Volumes/") else {
            return progress("error", ["code": "notWritable", "page": rel.page])
        }
        busy = true
        progress("downloading", [:])
        var req = URLRequest(url: rel.dmg, timeoutInterval: 120)
        req.setValue("AI-Watchdog-mac", forHTTPHeaderField: "User-Agent")
        URLSession.shared.downloadTask(with: req) { tmp, _, err in
            let fail = { (msg: String) in DispatchQueue.main.async { self.busy = false; progress("error", ["message": msg, "page": rel.page]) } }
            guard let tmp, err == nil else { return fail(err?.localizedDescription ?? "download failed") }
            DispatchQueue.main.async { progress("installing", [:]) }
            do {
                let newApp = try Self.prepare(dmg: tmp, expect: rel, nextTo: appURL)
                try Self.swap(current: appURL, with: newApp)
                DispatchQueue.main.async { relaunch(appURL) }
            } catch {
                fail(error.localizedDescription)
            }
        }.resume()
    }

    private struct Fail: LocalizedError { let errorDescription: String? ; init(_ s: String) { errorDescription = s } }

    /// 받은 DMG 를 확인하고 안의 앱을 지금 앱 옆(같은 디스크)에 복사해 둠
    private static func prepare(dmg: URL, expect: Release, nextTo appURL: URL) throws -> URL {
        let data = try Data(contentsOf: dmg)
        if let want = expect.digest {
            let got = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard got == want.lowercased() else { throw Fail("SHA-256 mismatch") }
        }
        let work = FileManager.default.temporaryDirectory.appendingPathComponent("aiwd-update-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }
        let image = work.appendingPathComponent("update.dmg")
        try data.write(to: image)
        let mount = work.appendingPathComponent("mnt")
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        guard run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint", mount.path, image.path]) == 0 else {
            throw Fail("cannot open DMG")
        }
        defer { _ = run("/usr/bin/hdiutil", ["detach", mount.path, "-quiet", "-force"]) }

        let src = mount.appendingPathComponent("AI Watchdog.app")
        guard let b = Bundle(url: src), b.bundleIdentifier == Bundle.main.bundleIdentifier else { throw Fail("not AI Watchdog") }
        let v = b.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        guard isNewer(v, than: current) else { throw Fail("not newer (\(v))") }
        guard run("/usr/bin/codesign", ["--verify", "--deep", src.path]) == 0 else { throw Fail("signature check failed") }

        let staged = appURL.deletingLastPathComponent().appendingPathComponent(".AI Watchdog.update.app")
        try? FileManager.default.removeItem(at: staged)
        guard run("/usr/bin/ditto", [src.path, staged.path]) == 0 else { throw Fail("copy failed") }
        return staged
    }

    /// 지금 앱 ↔ 새 앱 바꾸기. 실패하면 원래대로 되돌림
    private static func swap(current: URL, with staged: URL) throws {
        let fm = FileManager.default
        let old = current.deletingLastPathComponent().appendingPathComponent(".AI Watchdog.old.app")
        try? fm.removeItem(at: old)
        try fm.moveItem(at: current, to: old)
        do {
            try fm.moveItem(at: staged, to: current)
        } catch {
            try? fm.moveItem(at: old, to: current)
            throw error
        }
        try? fm.removeItem(at: old)
    }

    @discardableResult
    private static func run(_ path: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }

    /// 지금 앱이 끝난 뒤 새 앱을 켬
    static func relaunch(_ app: URL) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1.5; /usr/bin/open \"$0\"", app.path]
        try? p.run()
    }
}
