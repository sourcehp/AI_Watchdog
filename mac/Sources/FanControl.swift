// 팬 제어 (앱 쪽): root 도우미 설치·제거, 도우미에게 보낼 명령 파일 쓰기, 살아 있다는 신호
// 도우미는 명령 파일의 ts 가 15초 넘게 멈추면 팬을 자동으로 되돌림 → 앱이 죽어도 안전.
import AppKit

final class FanControl {
    static let label = "com.nik.aiwatchdog.fanhelper"
    static let helperPath = "/Library/PrivilegedHelperTools/\(label)"
    static let plistPath = "/Library/LaunchDaemons/\(label).plist"
    static let commandPath = "/Library/Application Support/AIWatchdog/fan.json"

    private var targets: [Double?] = []        // 팬별 원하는 RPM (nil = 자동)
    private var lastWrite: TimeInterval = 0
    private(set) var status = "missing"        // unsupported | missing | outdated | ready

    private var bundledHelper: URL? { Bundle.main.url(forAuxiliaryExecutable: "aiwatchdog-fanhelper") }
    private var script: URL? { Bundle.main.url(forResource: "fanhelper", withExtension: "sh") }

    init() { refresh() }

    func refresh() {
        let fm = FileManager.default
        if !SMC.shared.fanControlSupported { status = "unsupported"; return }
        guard fm.fileExists(atPath: Self.helperPath), fm.fileExists(atPath: Self.plistPath),
              fm.isWritableFile(atPath: Self.commandPath) else { status = "missing"; return }
        if let b = bundledHelper, !fm.contentsEqual(atPath: b.path, andPath: Self.helperPath) { status = "outdated"; return }
        status = "ready"
    }

    /// fans: [{mode: "auto"|"manual", rpm}] — 화면이 보낸 원하는 상태
    func apply(_ fans: [[String: Any]]) {
        targets = fans.map { f in
            guard f["mode"] as? String == "manual", let r = (f["rpm"] as? NSNumber)?.doubleValue, r.isFinite, r > 0 else { return nil }
            return r
        }
        write()
    }

    func allAuto() { targets = []; write() }

    /// 1초마다 부름: 수동인 팬이 있으면 2초마다 ts 를 새로 써서 도우미에게 살아 있음을 알림
    func heartbeat() {
        guard targets.contains(where: { $0 != nil }), Date().timeIntervalSince1970 - lastWrite >= 2 else { return }
        write()
    }

    private func write() {
        guard status == "ready" || status == "outdated" else { return }
        let now = Date().timeIntervalSince1970
        let doc: [String: Any] = ["ts": now, "fans": targets.map { t -> [String: Any] in ["rpm": t ?? NSNull()] }]
        guard let data = try? JSONSerialization.data(withJSONObject: doc),
              let h = FileHandle(forWritingAtPath: Self.commandPath) else { return }
        // 폴더가 root 소유라 새 파일로 바꿔치기(원자적 쓰기)는 안 됨 → 같은 파일을 덮어씀
        h.truncateFile(atOffset: 0); h.write(data); try? h.close()
        lastWrite = now
    }

    // ---------------------------------------------------------------- 설치·제거 (macOS 관리자 암호 창이 뜸)
    /// 실패하면 이유, 사용자가 취소하면 "", 성공하면 nil
    func install() -> String? {
        guard let s = script, let b = bundledHelper else { return "helper missing from app" }
        return runAdmin("\(Self.q(s.path)) install \(Self.q(b.path)) \(getuid())")
    }

    func remove() -> String? {
        allAuto()
        guard let s = script else { return "helper script missing from app" }
        return runAdmin("\(Self.q(s.path)) remove")
    }

    private func runAdmin(_ args: String) -> String? {
        let cmd = "/bin/sh " + args
        let src = "do shell script \"\(cmd.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\" with administrator privileges"
        var err: NSDictionary?
        NSAppleScript(source: src)?.executeAndReturnError(&err)
        refresh()
        guard let e = err else { return nil }
        if (e[NSAppleScript.errorNumber] as? Int) == -128 { return "" }       // 사용자가 취소
        return (e[NSAppleScript.errorMessage] as? String) ?? "failed"
    }

    private static func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}
