// SMC(시스템 관리 컨트롤러) 읽기·쓰기 — 앱과 팬 도우미가 함께 씀.
// 읽기는 누구나, 쓰기(팬 속도)는 root 만 됨.
import Foundation
import IOKit

final class SMC {
    // C 의 SMCKeyData_t 와 같은 모양 (80바이트). KeyInfo 는 C 처럼 12바이트로 채워야 함.
    private struct Vers { var major: UInt8 = 0, minor: UInt8 = 0, build: UInt8 = 0, reserved: UInt8 = 0; var release: UInt16 = 0 }
    private struct PLimit { var version: UInt16 = 0, length: UInt16 = 0; var cpu: UInt32 = 0, gpu: UInt32 = 0, mem: UInt32 = 0 }
    private struct KeyInfo { var size: UInt32 = 0; var type: UInt32 = 0; var attr: UInt8 = 0; var p1: UInt8 = 0, p2: UInt8 = 0, p3: UInt8 = 0 }
    private typealias Bytes32 = (UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
                                 UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8)
    private struct Param {
        var key: UInt32 = 0
        var vers = Vers()
        var limit = PLimit()
        var info = KeyInfo()
        var result: UInt8 = 0, status: UInt8 = 0, cmd: UInt8 = 0
        var data32: UInt32 = 0
        var bytes: Bytes32 = (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    }
    private enum Cmd: UInt8 { case read = 5, write = 6, byIndex = 8, info = 9 }

    struct Value { let type: String; let bytes: [UInt8] }

    static let shared = SMC()
    private var conn: io_connect_t = 0
    private var infoCache: [UInt32: KeyInfo] = [:]
    private let lock = NSLock()

    var isOpen: Bool { conn != 0 }

    init() {
        let svc = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"))
        guard svc != 0 else { return }
        defer { IOObjectRelease(svc) }
        var c: io_connect_t = 0
        if IOServiceOpen(svc, mach_task_self_, 0, &c) == KERN_SUCCESS { conn = c }
    }

    deinit { if conn != 0 { IOServiceClose(conn) } }

    static func code(_ s: String) -> UInt32 { s.utf8.prefix(4).reduce(0) { $0 << 8 | UInt32($1) } }
    static func name(_ v: UInt32) -> String {
        String(bytes: [UInt8(v >> 24), UInt8((v >> 16) & 255), UInt8((v >> 8) & 255), UInt8(v & 255)], encoding: .ascii) ?? "????"
    }

    private func call(_ p: inout Param) -> kern_return_t {
        guard conn != 0 else { return kIOReturnNotOpen }
        var out = Param()
        var size = MemoryLayout<Param>.stride
        let r = IOConnectCallStructMethod(conn, 2, &p, MemoryLayout<Param>.stride, &out, &size)
        p = out
        return r
    }

    private func info(_ key: UInt32) -> KeyInfo? {
        if let i = infoCache[key] { return i }
        var p = Param(); p.key = key; p.cmd = Cmd.info.rawValue
        guard call(&p) == KERN_SUCCESS, p.result == 0 else { return nil }
        infoCache[key] = p.info
        return p.info
    }

    func read(_ key: String) -> Value? {
        lock.lock(); defer { lock.unlock() }
        let k = Self.code(key)
        guard let i = info(k) else { return nil }
        var p = Param(); p.key = k; p.info.size = i.size; p.cmd = Cmd.read.rawValue
        guard call(&p) == KERN_SUCCESS, p.result == 0 else { return nil }
        let n = Int(min(i.size, 32))
        let bytes = withUnsafeBytes(of: p.bytes) { Array($0.prefix(n)) }
        return Value(type: Self.name(i.type), bytes: bytes)
    }

    /// 숫자로 읽기: flt, ui8/16/32, sp78(온도, Intel), fpe2(팬, Intel)
    func number(_ key: String) -> Double? {
        guard let v = read(key) else { return nil }
        let b = v.bytes
        switch v.type {
        case "flt ": return b.count == 4 ? Double(b.withUnsafeBytes { $0.loadUnaligned(as: Float.self) }) : nil
        case "ui8 ": return b.count >= 1 ? Double(b[0]) : nil
        case "ui16": return b.count >= 2 ? Double(UInt16(b[0]) << 8 | UInt16(b[1])) : nil
        case "ui32": return b.count >= 4 ? Double(UInt32(b[0]) << 24 | UInt32(b[1]) << 16 | UInt32(b[2]) << 8 | UInt32(b[3])) : nil
        case "sp78": return b.count >= 2 ? Double(Int16(bitPattern: UInt16(b[0]) << 8 | UInt16(b[1]))) / 256 : nil
        case "fpe2": return b.count >= 2 ? Double(UInt16(b[0]) << 8 | UInt16(b[1])) / 4 : nil
        default: return nil
        }
    }

    /// 키 쓰기 (root 필요). 성공하면 true
    @discardableResult
    func write(_ key: String, _ bytes: [UInt8]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let k = Self.code(key)
        guard let i = info(k), Int(i.size) == bytes.count else { return false }
        var p = Param(); p.key = k; p.info.size = i.size; p.cmd = Cmd.write.rawValue
        withUnsafeMutableBytes(of: &p.bytes) { raw in for (n, b) in bytes.enumerated() where n < 32 { raw[n] = b } }
        return call(&p) == KERN_SUCCESS && p.result == 0
    }

    func writeNumber(_ key: String, _ value: Double) -> Bool {
        guard let v = read(key) else { return false }
        switch v.type {
        case "flt ": var f = Float(value); return write(key, withUnsafeBytes(of: &f) { Array($0) })
        case "ui8 ": return write(key, [UInt8(max(0, min(255, value)))])
        case "fpe2": let n = UInt16(max(0, min(16383, value)) * 4); return write(key, [UInt8(n >> 8), UInt8(n & 255)])
        default: return false
        }
    }

    /// 모든 키 이름 (처음 한 번, 수천 개라 조금 걸림)
    func allKeys() -> [String] {
        guard let n = number("#KEY"), n > 0 else { return [] }
        var out: [String] = []
        out.reserveCapacity(Int(n))
        lock.lock(); defer { lock.unlock() }
        for i in 0..<UInt32(n) {
            var p = Param(); p.cmd = Cmd.byIndex.rawValue; p.data32 = i
            if call(&p) == KERN_SUCCESS, p.result == 0 { out.append(Self.name(p.key)) }
        }
        return out
    }

    // ---------------------------------------------------------------- 팬
    struct Fan { let index: Int; let rpm: Double; let min: Double; let max: Double; let target: Double; let manual: Bool }

    var fanCount: Int { Int(number("FNum") ?? 0) }

    func fans() -> [Fan] {
        (0..<fanCount).compactMap { i in
            guard let rpm = number("F\(i)Ac") else { return nil }
            let mn = number("F\(i)Mn") ?? 0, mx = number("F\(i)Mx") ?? max(rpm, 1)
            return Fan(index: i, rpm: rpm, min: mn, max: mx, target: number("F\(i)Tg") ?? rpm, manual: (number("F\(i)Md") ?? 0) >= 1)
        }
    }

    /// 이 Mac에서 팬 속도를 직접 정할 수 있는 형식인지 (Apple Silicon 방식: F0Md 키가 있음)
    var fanControlSupported: Bool { fanCount > 0 && read("F0Md") != nil }

    /// rpm == nil 이면 자동으로 되돌림 (root 필요)
    @discardableResult
    func setFan(_ i: Int, rpm: Double?) -> Bool {
        guard i >= 0, i < fanCount else { return false }
        if read("Ftst") != nil { _ = writeNumber("Ftst", rpm == nil ? 0 : 1) }   // 일부 기종은 먼저 잠금을 풀어야 함
        guard let r = rpm else { return writeNumber("F\(i)Md", 0) }
        let mn = number("F\(i)Mn") ?? 0, mx = number("F\(i)Mx") ?? 0
        guard mx > mn else { return false }
        let clamped = min(mx, max(mn, r))
        let a = writeNumber("F\(i)Md", 1)
        let b = writeNumber("F\(i)Tg", clamped)
        return a && b
    }
}
