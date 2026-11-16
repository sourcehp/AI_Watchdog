// 깨워 두기(caffeinate), 화면 끄기·절전·종료, 로그인 항목, 알림
import AppKit
import ServiceManagement
import UserNotifications

final class Power {
    private var caffeinate: Process?
    private var keepDisplay = false

    /// on=true 이면 맥을 깨워 둠. AI Watchdog가 죽으면 caffeinate 도 같이 끝남(-w).
    func hold(_ on: Bool, display: Bool) {
        if !on { release(); return }
        if let p = caffeinate, p.isRunning, keepDisplay == display { return }
        release()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
        p.arguments = (display ? ["-d", "-i"] : ["-i"]) + ["-w", String(getpid())]
        do { try p.run(); caffeinate = p; keepDisplay = display } catch { caffeinate = nil }
    }

    func release() {
        if let p = caffeinate, p.isRunning { p.terminate() }
        caffeinate = nil
    }

    func screenOff() {
        // 마우스를 막 누른 직후라 바로 다시 켜지지 않게 잠깐 기다림
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { Self.run("/usr/bin/pmset", ["displaysleepnow"]) }
    }

    func sleepNow() {
        release()
        Self.run("/usr/bin/pmset", ["sleepnow"])
    }

    /// 실패하면 이유를 돌려줌 (처음엔 "System Events 제어" 허용 창이 뜸)
    func shutdown() -> String? {
        release()
        var err: NSDictionary?
        NSAppleScript(source: "tell application \"System Events\" to shut down")?.executeAndReturnError(&err)
        guard let e = err else { return nil }
        return (e[NSAppleScript.errorMessage] as? String) ?? "shutdown failed"
    }

    private static func run(_ path: String, _ args: [String]) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        try? p.run()
    }

    // ---------------------------------------------------------------- 로그인할 때 실행
    static var startupEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func setStartup(_ on: Bool) -> String? {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    // ---------------------------------------------------------------- 알림
    static func notify(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return fallbackNotify(title: title, body: body) }
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)) { error in
                if error != nil { fallbackNotify(title: title, body: body) }
            }
        }
    }

    private static func fallbackNotify(title: String, body: String) {
        let esc = { (s: String) in s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        run("/usr/bin/osascript", ["-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\""])
    }
}
