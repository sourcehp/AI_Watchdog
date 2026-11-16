// 시스템 페이지·팬 페이지용 측정: 온도, 팬, 배터리, 저장 공간, 네트워크 상세, GPU 메모리
import Foundation
import IOKit
import IOKit.ps
import SystemConfiguration

enum Sensors {
    // ---------------------------------------------------------------- 온도
    // 기종마다 키가 달라서 처음 한 번 SMC 키 전체를 훑어 그룹을 나눔 (백그라운드)
    private static var cpuKeys: [String] = [], gpuKeys: [String] = [], batKeys: [String] = []
    private static var discovered = false, discovering = false

    static func discoverIfNeeded() {
        guard !discovered, !discovering else { return }
        discovering = true
        DispatchQueue.global(qos: .utility).async {
            let smc = SMC.shared
            var cpu: [String] = [], gpu: [String] = [], bat: [String] = [], intelCpu: [String] = [], intelGpu: [String] = []
            for k in smc.allKeys() where k.hasPrefix("T") {
                guard let v = smc.number(k), v > 5, v < 130 else { continue }
                if k.hasPrefix("Tp") || k.hasPrefix("Te") { cpu.append(k) }
                else if k.hasPrefix("Tg") { gpu.append(k) }
                else if k.hasPrefix("TB") && k.hasSuffix("T") { bat.append(k) }
                else if k.hasPrefix("TC") && k != "TCHP" { intelCpu.append(k) }
                else if k.hasPrefix("TG") { intelGpu.append(k) }
            }
            DispatchQueue.main.async {
                cpuKeys = cpu.isEmpty ? intelCpu : cpu
                gpuKeys = gpu.isEmpty ? intelGpu : gpu
                batKeys = bat
                discovered = true
            }
        }
    }

    private static func temps(_ keys: [String]) -> [Double] {
        keys.compactMap { SMC.shared.number($0) }.filter { $0 > 5 && $0 < 130 }
    }
    private static func avg(_ v: [Double]) -> Any { v.isEmpty ? NSNull() : (v.reduce(0, +) / Double(v.count) * 10).rounded() / 10 }

    /// {cpu, cpuMax, gpu, battery} ℃ — 아직 키를 못 찾았거나 없으면 NSNull
    static func temperatures() -> [String: Any] {
        discoverIfNeeded()
        let c = temps(cpuKeys), g = temps(gpuKeys), b = temps(batKeys)
        return ["cpu": avg(c), "cpuMax": c.max().map { ($0 * 10).rounded() / 10 } ?? NSNull(), "gpu": avg(g), "battery": avg(b)]
    }

    // ---------------------------------------------------------------- 팬
    static func fans() -> [[String: Any]] {
        SMC.shared.fans().map { ["rpm": $0.rpm.rounded(), "min": $0.min.rounded(), "max": $0.max.rounded(),
                                 "target": $0.target.rounded(), "manual": $0.manual] }
    }

    // ---------------------------------------------------------------- 배터리
    static func battery() -> [String: Any]? {
        let svc = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSmartBattery"))
        guard svc != 0 else { return nil }
        defer { IOObjectRelease(svc) }
        var props: Unmanaged<CFMutableDictionary>?
        guard IORegistryEntryCreateCFProperties(svc, &props, kCFAllocatorDefault, 0) == KERN_SUCCESS,
              let d = props?.takeRetainedValue() as? [String: Any] else { return nil }
        let num = { (k: String) -> Double? in (d[k] as? NSNumber)?.doubleValue }
        var out: [String: Any] = [:]
        out["pct"] = num("CurrentCapacity") ?? NSNull()
        out["plugged"] = (d["ExternalConnected"] as? Bool) ?? false
        out["charging"] = (d["IsCharging"] as? Bool) ?? false
        out["full"] = (d["FullyCharged"] as? Bool) ?? false
        out["cycles"] = num("CycleCount") ?? NSNull()
        if let t = num("Temperature") { out["temp"] = (t / 10).rounded() / 10 }
        if let raw = num("AppleRawMaxCapacity"), let design = num("DesignCapacity"), design > 0 {
            out["health"] = (raw / design * 1000).rounded() / 10
        }
        if let a = d["AdapterDetails"] as? [String: Any], let w = (a["Watts"] as? NSNumber)?.doubleValue, w > 0 { out["adapterW"] = w }
        if let p = d["PowerTelemetryData"] as? [String: Any] {
            let mw = { (k: String) -> Double? in (p[k] as? NSNumber)?.doubleValue }
            if let v = mw("SystemPowerIn") { out["inW"] = (v / 100).rounded() / 10 }
            if let v = mw("SystemLoad") { out["loadW"] = (v / 100).rounded() / 10 }
        }
        if let m = num("AvgTimeToEmpty"), m > 0, m < 65535 { out["minLeft"] = m }
        return out
    }

    // ---------------------------------------------------------------- 저장 공간 (시동 디스크)
    static func storage() -> [String: Any] {
        let keys: Set<URLResourceKey> = [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey, .volumeAvailableCapacityKey]
        guard let v = try? URL(fileURLWithPath: "/").resourceValues(forKeys: keys), let total = v.volumeTotalCapacity else { return [:] }
        let free = Double(v.volumeAvailableCapacityForImportantUsage ?? Int64(v.volumeAvailableCapacity ?? 0))
        return ["total": Double(total), "free": free]
    }

    // ---------------------------------------------------------------- 네트워크
    /// 루프백을 뺀 모든 장치의 누적 (받은 바이트, 보낸 바이트)
    static func networkInOut() -> (rx: Double, tx: Double) {
        var mib: [Int32] = [CTL_NET, PF_ROUTE, 0, 0, NET_RT_IFLIST2, 0]
        var len = 0
        guard sysctl(&mib, 6, nil, &len, nil, 0) == 0, len > 0 else { return (0, 0) }
        var buf = [UInt8](repeating: 0, count: len)
        guard sysctl(&mib, 6, &buf, &len, nil, 0) == 0 else { return (0, 0) }
        var rx = 0.0, tx = 0.0
        buf.withUnsafeBytes { raw in
            var off = 0
            while off + MemoryLayout<if_msghdr>.size <= len {
                let hdr = raw.loadUnaligned(fromByteOffset: off, as: if_msghdr.self)
                let msgLen = Int(hdr.ifm_msglen)
                if msgLen <= 0 { break }
                if Int32(hdr.ifm_type) == RTM_IFINFO2, off + MemoryLayout<if_msghdr2>.size <= len {
                    let h2 = raw.loadUnaligned(fromByteOffset: off, as: if_msghdr2.self)
                    if (h2.ifm_flags & IFF_LOOPBACK) == 0 {
                        rx += Double(h2.ifm_data.ifi_ibytes); tx += Double(h2.ifm_data.ifi_obytes)
                    }
                }
                off += msgLen
            }
        }
        return (rx, tx)
    }

    /// 지금 인터넷에 쓰는 장치: {kind: wifi|ethernet|other, ip}
    static func primaryNetwork() -> [String: Any] {
        guard let store = SCDynamicStoreCreate(nil, "AIWatchdog" as CFString, nil, nil),
              let g = SCDynamicStoreCopyValue(store, "State:/Network/Global/IPv4" as CFString) as? [String: Any],
              let ifname = g["PrimaryInterface"] as? String else { return ["kind": "none"] }
        var kind = "other"
        if let all = SCNetworkInterfaceCopyAll() as? [SCNetworkInterface] {
            for i in all where (SCNetworkInterfaceGetBSDName(i) as String?) == ifname {
                let t = SCNetworkInterfaceGetInterfaceType(i) as String?
                kind = t == (kSCNetworkInterfaceTypeIEEE80211 as String) ? "wifi" : t == (kSCNetworkInterfaceTypeEthernet as String) ? "ethernet" : "other"
            }
        }
        var ip = ""
        var addrs: UnsafeMutablePointer<ifaddrs>?
        if getifaddrs(&addrs) == 0, let first = addrs {
            var p: UnsafeMutablePointer<ifaddrs>? = first
            while let a = p {
                if String(cString: a.pointee.ifa_name) == ifname, let sa = a.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) {
                    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                        ip = String(cString: host)
                    }
                }
                p = a.pointee.ifa_next
            }
            freeifaddrs(first)
        }
        return ["kind": kind, "ip": ip]
    }

    // ---------------------------------------------------------------- GPU 메모리 (사용 중 바이트)
    static func gpuMemory() -> Double? {
        var iter: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iter) == KERN_SUCCESS else { return nil }
        defer { IOObjectRelease(iter) }
        var best: Double?
        var svc = IOIteratorNext(iter)
        while svc != 0 {
            if let prop = IORegistryEntryCreateCFProperty(svc, "PerformanceStatistics" as CFString, kCFAllocatorDefault, 0)?
                .takeRetainedValue() as? [String: Any],
               let v = (prop["In use system memory"] ?? prop["vramUsedBytes"]) as? NSNumber {
                best = max(best ?? 0, v.doubleValue)
            }
            IOObjectRelease(svc)
            svc = IOIteratorNext(iter)
        }
        return best
    }

    /// 압축된 메모리 바이트
    static func compressedMemory() -> Double {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
        }
        return kr == KERN_SUCCESS ? Double(stats.compressor_page_count) * Double(getpagesize()) : 0
    }
}
