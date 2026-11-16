// 맥 상태 측정: 프로세스(이름·부모·CPU 시간·메모리), 입력 없는 시간, CPU·메모리·GPU·네트워크
import AppKit
import Darwin
import IOKit

struct ProcInfo {
    let pid: Int32
    let ppid: Int32
    let name: String
    let cpuSec: Double
    let mem: Double
}

enum Probe {
    // proc_taskinfo 의 CPU 시간은 mach 시간 단위 (Apple Silicon 에서는 나노초가 아님)
    private static let nanosPerTick: Double = {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return tb.denom == 0 ? 1 : Double(tb.numer) / Double(tb.denom)
    }()

    private static func cString<T>(_ value: T) -> String {
        var v = value
        return withUnsafeBytes(of: &v) { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            let end = bytes.firstIndex(of: 0) ?? bytes.count
            return String(decoding: bytes[..<end], as: UTF8.self)
        }
    }

    /// 현재 사용자가 실행한 프로세스 (다른 사용자·시스템 프로세스는 권한상 읽히지 않으므로 건너뜀)
    static func processes() -> [ProcInfo] {
        let estimate = proc_listallpids(nil, 0)
        guard estimate > 0 else { return [] }
        var pids = [pid_t](repeating: 0, count: Int(estimate) + 128)
        let n = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        guard n > 0 else { return [] }
        let uid = getuid()
        var out: [ProcInfo] = []
        out.reserveCapacity(Int(n))
        var info = proc_taskallinfo()
        let size = Int32(MemoryLayout<proc_taskallinfo>.size)
        for pid in pids.prefix(Int(n)) where pid > 0 {
            guard proc_pidinfo(pid, PROC_PIDTASKALLINFO, 0, &info, size) == size else { continue }
            guard info.pbsd.pbi_uid == uid else { continue }
            var name = cString(info.pbsd.pbi_name)
            if name.isEmpty { name = cString(info.pbsd.pbi_comm) }
            let ticks = Double(info.ptinfo.pti_total_user) + Double(info.ptinfo.pti_total_system)
            out.append(ProcInfo(pid: pid, ppid: Int32(info.pbsd.pbi_ppid), name: name,
                                cpuSec: ticks * nanosPerTick / 1e9, mem: Double(info.ptinfo.pti_resident_size)))
        }
        return out
    }

    /// 키보드·마우스 입력이 없었던 시간(초)
    static func userIdleSeconds() -> Double {
        guard let any = CGEventType(rawValue: UInt32.max) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }

    // 전체 CPU 사용률: 직전 호출과의 틱 차이
    private static var prevCpu: (busy: UInt64, total: UInt64)?
    static func cpuPercent() -> Double? {
        var load = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &load) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        let t = load.cpu_ticks
        let user = UInt64(t.0), sys = UInt64(t.1), idle = UInt64(t.2), nice = UInt64(t.3)
        let busy = user + sys + nice, total = busy + idle
        defer { prevCpu = (busy, total) }
        guard let p = prevCpu, total > p.total else { return nil }
        return Double(busy - p.busy) * 100 / Double(total - p.total)
    }

    /// [전체 바이트, 사용 중 바이트] (활성 상태 보기의 "사용된 메모리"와 같은 방식)
    static func memory() -> (total: Double, used: Double) {
        let total = Double(ProcessInfo.processInfo.physicalMemory)
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return (total, 0) }
        let page = Double(getpagesize())
        let app = Double(stats.internal_page_count) - Double(stats.purgeable_count)
        let used = (app + Double(stats.wire_count) + Double(stats.compressor_page_count)) * page
        return (total, min(total, max(0, used)))
    }

    /// GPU 전체 사용률(%) — 읽을 수 없으면 nil
    static func gpuPercent() -> Double? {
        var iter: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iter) == KERN_SUCCESS else { return nil }
        defer { IOObjectRelease(iter) }
        var best: Double?
        var svc = IOIteratorNext(iter)
        while svc != 0 {
            if let prop = IORegistryEntryCreateCFProperty(svc, "PerformanceStatistics" as CFString, kCFAllocatorDefault, 0)?
                .takeRetainedValue() as? [String: Any],
               let v = (prop["Device Utilization %"] ?? prop["GPU Activity(%)"]) as? NSNumber {
                best = max(best ?? 0, v.doubleValue)
            }
            IOObjectRelease(svc)
            svc = IOIteratorNext(iter)
        }
        return best
    }

    static let chipName: String = {
        var size = 0
        guard sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var buf = [CChar](repeating: 0, count: size)
        sysctlbyname("machdep.cpu.brand_string", &buf, &size, nil, 0)
        return String(cString: buf)
    }()

    /// 모든 네트워크 장치의 누적 송수신 바이트 (루프백 제외, 64비트 카운터)
    static func networkBytes() -> Double {
        var mib: [Int32] = [CTL_NET, PF_ROUTE, 0, 0, NET_RT_IFLIST2, 0]
        var len = 0
        guard sysctl(&mib, 6, nil, &len, nil, 0) == 0, len > 0 else { return 0 }
        var buf = [UInt8](repeating: 0, count: len)
        guard sysctl(&mib, 6, &buf, &len, nil, 0) == 0 else { return 0 }
        var sum = 0.0
        buf.withUnsafeBytes { raw in
            var off = 0
            while off + MemoryLayout<if_msghdr>.size <= len {
                let hdr = raw.loadUnaligned(fromByteOffset: off, as: if_msghdr.self)
                let msgLen = Int(hdr.ifm_msglen)
                if msgLen <= 0 { break }
                if Int32(hdr.ifm_type) == RTM_IFINFO2, off + MemoryLayout<if_msghdr2>.size <= len {
                    let h2 = raw.loadUnaligned(fromByteOffset: off, as: if_msghdr2.self)
                    if (h2.ifm_flags & IFF_LOOPBACK) == 0 {
                        sum += Double(h2.ifm_data.ifi_ibytes) + Double(h2.ifm_data.ifi_obytes)
                    }
                }
                off += msgLen
            }
        }
        return sum
    }

    /// "실행 중인 프로그램에서 추가" 목록: 일반 앱 + 터미널에서 띄운 명령
    static func pickList() -> [[String: String]] {
        var seen = Set<String>(), out: [[String: String]] = []
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            guard let exe = app.executableURL?.lastPathComponent, !exe.isEmpty, seen.insert(exe.lowercased()).inserted else { continue }
            out.append(["name": exe, "label": app.localizedName ?? exe])
        }
        let procs = processes()
        let byPid = Dictionary(procs.map { ($0.pid, $0) }, uniquingKeysWith: { a, _ in a })
        let shells: Set<String> = ["zsh", "bash", "sh", "fish", "login", "tmux", "screen"]
        let skip: Set<String> = ["zsh", "bash", "sh", "fish", "login", "tmux", "screen", "ps", "top", "less", "man", "ssh"]
        for p in procs {
            let low = p.name.lowercased()
            guard let parent = byPid[p.ppid], shells.contains(parent.name.lowercased()),
                  !skip.contains(low), seen.insert(low).inserted else { continue }
            out.append(["name": p.name, "label": p.name])
        }
        return out
    }
}
