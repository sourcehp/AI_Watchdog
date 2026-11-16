// AI Watchdog 팬 도우미 — root 로 실행되는 작은 프로그램 (LaunchDaemon).
// 하는 일은 하나: 명령 파일을 1초마다 읽고 팬 속도를 정함.
// 안전장치: 명령이 이상하면 무시, RPM 은 각 팬의 최소~최대로 자름,
//          앱 신호(ts)가 15초 넘게 멈추면·끝날 때·시작할 때 모든 팬을 자동으로.
import Foundation

let commandPath = "/Library/Application Support/AIWatchdog/fan.json"
let staleAfter: TimeInterval = 15
let smc = SMC.shared

func allAuto() { for i in 0..<smc.fanCount { smc.setFan(i, rpm: nil) } }

guard smc.isOpen else { FileHandle.standardError.write(Data("SMC not available\n".utf8)); exit(1) }
allAuto()

// 끝날 때(제거·재설치·재시동) 팬을 자동으로 되돌리고 나감
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { allAuto(); exit(0) }
    src.resume()
    signalSources.append(src)
}

var manual: [Bool] = []

func step() {
    let n = smc.fanCount
    if manual.count != n { manual = Array(repeating: false, count: n) }
    var wanted: [Double?] = Array(repeating: nil, count: n)
    if let data = FileManager.default.contents(atPath: commandPath),
       let doc = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let ts = (doc["ts"] as? NSNumber)?.doubleValue,
       let fans = doc["fans"] as? [[String: Any]] {
        let age = Date().timeIntervalSince1970 - ts
        if age >= -60, age <= staleAfter {
            for (i, f) in fans.enumerated() where i < n {
                if let r = (f["rpm"] as? NSNumber)?.doubleValue, r.isFinite, r > 0 { wanted[i] = r }
            }
        }
    }
    for i in 0..<n {
        if let r = wanted[i] {
            smc.setFan(i, rpm: r)          // macOS 가 되돌릴 수 있어 매번 다시 씀
            manual[i] = true
        } else if manual[i] {
            smc.setFan(i, rpm: nil)
            manual[i] = false
        }
    }
}

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: 1.0, leeway: .milliseconds(200))
timer.setEventHandler(handler: step)
timer.resume()
dispatchMain()
