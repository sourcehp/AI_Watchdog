// AI Watchdog for macOS — 메뉴 막대 아이콘 + 창(WKWebView) + 1초 타이머 + 화면과의 다리
import AppKit
import WebKit
import UserNotifications

final class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, UNUserNotificationCenterDelegate {
    private let power = Power()
    private let fan = FanControl()
    private let tokens = TokenScanner()
    private var slowTick = 0
    private var slow: [String: Any] = [:]
    private var statusItem: NSStatusItem!
    private var panel: Panel!
    private var web: WKWebView!
    private var timer: Timer?
    private var ready = false
    private var wokeUp = false
    private var startHidden = false
    private let menu = NSMenu()
    private var miOpen: NSMenuItem!, miWake: NSMenuItem!, miWakeOff: NSMenuItem!, miQuit: NSMenuItem!

    private let width: CGFloat = 392
    private let supportDir: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AIWatchdog", isDirectory: true)
        try? FileManager.default.createDirectory(at: d.appendingPathComponent("lang"), withIntermediateDirectories: true)
        return d
    }()
    private var settingsURL: URL { supportDir.appendingPathComponent("settings.json") }
    private var sessionsURL: URL { supportDir.appendingPathComponent("sessions.csv") }

    // ---------------------------------------------------------------- 시작
    func applicationDidFinishLaunching(_ note: Notification) {
        // 하나만 실행: 이미 켜진 AI Watchdog가 있으면
        //  - 그쪽이 같거나 새 버전 → 그쪽 창을 열고 이쪽은 끝냄
        //  - 그쪽이 옛 버전 → 그쪽을 끄고 이쪽이 이어받음 (업데이트한 뒤 옛 앱이 남는 일 방지)
        if let id = Bundle.main.bundleIdentifier {
            let mine = Self.version(Bundle.main)
            for other in NSRunningApplication.runningApplications(withBundleIdentifier: id) where other.processIdentifier != getpid() {
                let theirs = other.bundleURL.flatMap { Bundle(url: $0) }.map(Self.version) ?? []
                if theirs.lexicographicallyPrecedes(mine) {
                    other.terminate()
                } else {
                    if let url = other.bundleURL { NSWorkspace.shared.openApplication(at: url, configuration: .init()) }
                    NSApp.terminate(nil)
                    return
                }
            }
        }
        // 로그인할 때 자동으로 켜졌으면 창 없이 메뉴 막대에서만 시작
        // 'prdt' = keyAEPropData, 'lgit' = keyAELaunchedAsLogInItem
        if let ev = NSAppleEventManager.shared().currentAppleEvent,
           ev.paramDescriptor(forKeyword: 0x70726474)?.enumCodeValue == 0x6C676974 {
            startHidden = true
        }
        if ProcessInfo.processInfo.systemUptime < 180 { startHidden = true }
        if !FileManager.default.fileExists(atPath: settingsURL.path) { startHidden = false }   // 처음 실행은 항상 보여 줌

        UNUserNotificationCenter.current().delegate = self
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = Self.dot(nil)
        statusItem.button?.toolTip = "AI Watchdog"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        miOpen = menu.addItem(withTitle: "Open", action: #selector(openWindow), keyEquivalent: "")
        menu.addItem(.separator())
        miWake = menu.addItem(withTitle: "Keep awake for 1 hour", action: #selector(wakeHour), keyEquivalent: "")
        miWakeOff = menu.addItem(withTitle: "Stop keeping awake", action: #selector(wakeOff), keyEquivalent: "")
        menu.addItem(.separator())
        miQuit = menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q")
        menu.items.forEach { $0.target = self }

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "aw")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 720), configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]

        panel = Panel(contentRect: NSRect(x: 0, y: 0, width: width, height: 720),
                      styleMask: [.borderless, .fullSizeContentView], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentView = web
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]

        let res = Bundle.main.resourceURL!
        web.loadFileURL(res.appendingPathComponent("ui/index.html"), allowingReadAccessTo: res)

        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.wokeUp = true
        }
        let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = 0.2
        RunLoop.main.add(t, forMode: .common)     // 메뉴가 열려 있어도 계속 돎
        timer = t
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWindow(); return true          // 이미 켜져 있을 때 앱을 다시 열면 창을 보여 줌
    }

    func applicationWillTerminate(_ note: Notification) { power.release(); fan.allAuto() }

    // 창이 열려 있어 앱이 활성 상태여도 알림 배너를 보여 줌
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) {
        h([.banner, .sound])
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        var data: [String: Any] = [
            "langs": loadLangs(),
            "todaySec": todaySeconds(),
            "sysLang": Locale.preferredLanguages.first ?? "en",
            "startup": Power.startupEnabled,
        ]
        if let d = try? Data(contentsOf: settingsURL), let s = try? JSONSerialization.jsonObject(with: d) { data["settings"] = s }
        call("AW.init", data)
        // 확인용: open "AI Watchdog.app" --args -startView tok  (main|sys|fan|tok)
        if let v = UserDefaults.standard.string(forKey: "startView") { call("AW.show", v) }
        // 확인용: --args -debugJS "자바스크립트" — 3초 뒤 화면에서 실행하고 결과를 debug.log 에 남김
        if let js = UserDefaults.standard.string(forKey: "debugJS") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.web.evaluateJavaScript(js) { r, e in self?.debugLog("debugJS → \(e.map { "\($0)" } ?? String(describing: r ?? "nil"))") }
            }
        }
        ready = true
        tick()
        if !startHidden { openWindow() }
    }

    // ---------------------------------------------------------------- 1초마다 측정해서 화면에 넘김
    private func tick() {
        guard ready else { return }
        let procs = Probe.processes().map { ["pid": $0.pid, "ppid": $0.ppid, "name": $0.name, "cpuSec": $0.cpuSec, "mem": $0.mem] as [String: Any] }
        var s: [String: Any] = ["procs": procs, "userIdleSec": Probe.userIdleSeconds()]
        s["cpuPct"] = Probe.cpuPercent() ?? NSNull()
        if panel.isVisible {           // 사용량 막대는 창이 보일 때만 잼 (숨어 있을 땐 일을 덜 함)
            let mem = Probe.memory()
            s["memTotal"] = mem.total; s["memUsed"] = mem.used
            s["netBytes"] = Probe.networkBytes()
            s["gpuPct"] = Probe.gpuPercent() ?? NSNull()
            s["gpuName"] = Probe.chipName
        } else {
            s["gpuPct"] = "skip"
        }
        // 팬·온도는 팬 커브 계산에 필요해서 항상 잼 (가벼움)
        s["fans"] = Sensors.fans()
        s["temps"] = Sensors.temperatures()
        s["fanHelper"] = fan.status
        if panel.isVisible {
            if slowTick % 5 == 0 {      // 배터리·저장 공간·네트워크 이름은 5초마다
                slow["battery"] = Sensors.battery() ?? NSNull()
                slow["disk"] = Sensors.storage()
                slow["net"] = Sensors.primaryNetwork()
            }
            slowTick += 1
            let io = Sensors.networkInOut()
            var sys = slow
            sys["rx"] = io.rx; sys["tx"] = io.tx
            if let c = Probe.cpuSplit { sys["cpuUser"] = c.user; sys["cpuSys"] = c.sys }
            sys["memCompressed"] = Sensors.compressedMemory()
            sys["gpuMem"] = Sensors.gpuMemory() ?? NSNull()
            s["sys"] = sys
        } else {
            slowTick = 0
        }
        fan.heartbeat()
        if wokeUp { s["wake"] = true; wokeUp = false }
        call("AW.tick", s)
    }

    private func call(_ fn: String, _ arg: Any) {
        if arg is [Any] || arg is [String: Any], !JSONSerialization.isValidJSONObject(arg) { return }
        guard let d = try? JSONSerialization.data(withJSONObject: arg, options: .fragmentsAllowed), let json = String(data: d, encoding: .utf8) else { return }
        web.evaluateJavaScript("\(fn)(\(json))", completionHandler: nil)
    }

    // ---------------------------------------------------------------- 화면에서 온 요청
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let cmd = m["cmd"] as? String else { return }
        switch cmd {
        case "hold":
            power.hold(m["on"] as? Bool ?? false, display: m["display"] as? Bool ?? false)
        case "act":
            switch m["kind"] as? String {
            case "screen": power.screenOff()
            case "sleep": power.sleepNow()
            case "shutdown": if let e = power.shutdown() { call("AW.error", e) }
            default: break
            }
        case "save":
            if let s = m["settings"], JSONSerialization.isValidJSONObject(s), let d = try? JSONSerialization.data(withJSONObject: s, options: [.prettyPrinted, .sortedKeys]) {
                try? d.write(to: settingsURL, options: .atomic)
            }
        case "log":
            appendSession(m)
        case "status":
            statusItem.button?.image = Self.dot(m["state"] as? String)
            statusItem.button?.toolTip = m["tip"] as? String
        case "size":
            if let h = (m["h"] as? NSNumber)?.doubleValue, h > 50 { resize(CGFloat(h)) }
        case "show":
            if m["alert"] as? Bool == true {
                openWindow()
                panel.level = .floating
                NSSound.beep()
            } else {
                panel.level = .normal
            }
        case "hide":
            panel.orderOut(nil)
        case "menu":
            miOpen.title = m["open"] as? String ?? miOpen.title
            miWake.title = m["wake1h"] as? String ?? miWake.title
            miWakeOff.title = m["wakeoff"] as? String ?? miWakeOff.title
            miQuit.title = m["quit"] as? String ?? miQuit.title
        case "startup":
            if let e = Power.setStartup(m["on"] as? Bool ?? false) { call("AW.error", e) }
        case "notify":
            Power.notify(title: m["title"] as? String ?? "AI Watchdog", body: m["body"] as? String ?? "")
        case "procs":
            call("AW.procList", Probe.pickList())
        case "fan":
            fan.apply(m["fans"] as? [[String: Any]] ?? [])
        case "fanInstall", "fanRemove":
            let err = cmd == "fanInstall" ? fan.install() : fan.remove()
            debugLog("\(cmd): \(err ?? "ok") → \(fan.status)")
            call("AW.fanResult", ["ok": err == nil, "error": err ?? "", "status": fan.status])
        case "tokens":
            tokens.scan { [weak self] rows in self?.call("AW.tokens", ["rows": rows]) }
        case "jsError":
            debugLog("JS error: " + (m["msg"] as? String ?? "?"))
        case "quit":
            quit()
        default:
            break
        }
    }

    // ---------------------------------------------------------------- 창
    @objc private func statusClicked() {
        let ev = NSApp.currentEvent
        if ev?.type == .rightMouseUp || ev?.modifierFlags.contains(.control) == true {
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        } else if panel.isVisible {
            panel.orderOut(nil)
        } else {
            openWindow()
        }
    }

    @objc private func openWindow() {
        if !panel.isVisible { placeUnderIcon() }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    private func placeUnderIcon() {
        let h = panel.frame.height
        if let btn = statusItem.button, let win = btn.window {
            let r = win.convertToScreen(btn.convert(btn.bounds, to: nil))
            let screen = win.screen ?? NSScreen.main
            var x = r.midX - width / 2
            if let vis = screen?.visibleFrame { x = min(max(x, vis.minX + 8), vis.maxX - width - 8) }
            panel.setFrame(NSRect(x: x, y: r.minY - 6 - h, width: width, height: h), display: true)
        } else {
            panel.center()
        }
    }

    private func resize(_ h: CGFloat) {
        var f = panel.frame
        guard abs(f.height - h) > 0.5 else { return }
        let top = f.maxY
        if let vis = (panel.screen ?? NSScreen.main)?.visibleFrame { f.size.height = min(h, vis.height - 12) } else { f.size.height = h }
        f.origin.y = top - f.size.height
        panel.setFrame(f, display: true)
        panel.invalidateShadow()
    }

    @objc private func wakeHour() { call("AW.wake", 60) }
    @objc private func wakeOff() { call("AW.wake", 0) }
    @objc private func quit() { power.release(); fan.allAuto(); NSApp.terminate(nil) }

    // ---------------------------------------------------------------- 파일
    private func loadLangs() -> [Any] {
        var byCode: [String: Any] = [:]
        let dirs = [Bundle.main.resourceURL!.appendingPathComponent("lang"), supportDir.appendingPathComponent("lang")]
        for dir in dirs {   // 사용자 폴더의 파일이 같은 코드의 기본 파일을 덮어씀
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for f in files where f.pathExtension.lowercased() == "json" {
                guard let d = try? Data(contentsOf: f), let doc = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                      let code = (doc["code"] as? String)?.lowercased(), doc["strings"] != nil else { continue }
                byCode[code] = doc
            }
        }
        return Array(byCode.values)
    }

    private func appendSession(_ m: [String: Any]) {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let start = Date(timeIntervalSince1970: (m["start"] as? NSNumber)?.doubleValue ?? 0)
        let end = Date(timeIntervalSince1970: (m["end"] as? NSNumber)?.doubleValue ?? 0)
        let sec = (m["sec"] as? NSNumber)?.intValue ?? 0
        let progs = (m["programs"] as? String ?? "").replacingOccurrences(of: "\"", with: "")
        var line = "\(fmt.string(from: start)),\(fmt.string(from: end)),\(sec),\"\(progs)\"\n"
        if !FileManager.default.fileExists(atPath: sessionsURL.path) { line = "start,end,seconds,programs\n" + line }
        guard let data = line.data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: sessionsURL) {
            h.seekToEndOfFile(); h.write(data); try? h.close()
        } else {
            try? data.write(to: sessionsURL)
        }
    }

    /// 문제를 찾을 때 보는 짧은 기록: ~/Library/Application Support/AIWatchdog/debug.log (200KB 넘으면 새로 시작)
    func debugLog(_ text: String) {
        let url = supportDir.appendingPathComponent("debug.log")
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(text)\n"
        guard let data = line.data(using: .utf8) else { return }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        if size < 200_000, let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(data); try? h.close()
        } else {
            try? data.write(to: url)
        }
    }

    private func todaySeconds() -> Double {
        guard let text = try? String(contentsOf: sessionsURL, encoding: .utf8) else { return 0 }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"
        let today = fmt.string(from: Date())
        return text.split(separator: "\n").dropFirst().reduce(0.0) { sum, row in
            let cols = row.split(separator: ",", maxSplits: 3, omittingEmptySubsequences: false)
            guard cols.count >= 3, cols[0].hasPrefix(today), let s = Double(cols[2]) else { return sum }
            return sum + s
        }
    }

    /// "1.1.0" + 빌드 번호 → [1, 1, 0, 빌드] (버전 비교용)
    static func version(_ b: Bundle) -> [Int] {
        let short = (b.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0")
        let build = Int(b.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0") ?? 0
        return short.split(separator: ".").map { Int($0) ?? 0 } + [build]
    }

    // ---------------------------------------------------------------- 메뉴 막대 아이콘 (고리 + 가운데 점)
    static func dot(_ state: String?) -> NSImage {
        let colors: [String: NSColor] = [
            "Lamp": NSColor(srgbRed: 0xE9 / 255, green: 0x9A / 255, blue: 0x2C / 255, alpha: 1),
            "Moon": NSColor(srgbRed: 0x55 / 255, green: 0x66 / 255, blue: 0xD4 / 255, alpha: 1),
            "Rose": NSColor(srgbRed: 0xDA / 255, green: 0x54 / 255, blue: 0x42 / 255, alpha: 1),
        ]
        let color = state.flatMap { colors[$0] }
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            (color ?? .black).set()
            let ring = NSBezierPath(ovalIn: NSRect(x: 2.75, y: 2.75, width: 12.5, height: 12.5))
            ring.lineWidth = 2
            ring.stroke()
            NSBezierPath(ovalIn: NSRect(x: 6.5, y: 6.5, width: 5, height: 5)).fill()
            return true
        }
        img.isTemplate = (color == nil)    // 꺼짐 상태는 메뉴 막대 색을 따름
        return img
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
