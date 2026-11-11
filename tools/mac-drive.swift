// Drives the mouse for tools/mac-video.sh, the way a person would: glides, clicks, scrolls, drags,
// and finds a control on screen by its accessible name (a web page's aria-label or text).
// Screen points, origin top-left (the same space as CGWindow bounds and the AX tree).
//
//   swiftc -O -o drive tools/mac-drive.swift
//   drive find <pid> <name>          prints "<x> <y>" (centre of the first match) or exits 1
//   drive move <x> <y> [ms]          glides from where the pointer is (default 450 ms)
//   drive click <x> <y>              glides there, then clicks
//   drive scroll <lines> [<x> <y>]   negative = down
//   drive drag <x1> <y1> <x2> <y2>   press, glide, release
//   drive trusted                    prints yes/no: may this process read other apps' controls?
import ApplicationServices
import CoreGraphics
import Foundation

func pointer() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func post(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button)?.post(tap: .cghidEventTap)
}

// Ease in-out glide, 120 steps a second, so a recording shows the pointer travel.
func glide(to end: CGPoint, ms: Double, dragging: Bool = false) {
    let start = pointer()
    let steps = max(1, Int(ms / 1000 * 120))
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let e = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        let p = CGPoint(x: start.x + (end.x - start.x) * e, y: start.y + (end.y - start.y) * e)
        post(dragging ? .leftMouseDragged : .mouseMoved, p)
        usleep(useconds_t(1_000_000 / 120))
    }
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func frame(_ el: AXUIElement) -> CGRect? {
    guard let pv = attr(el, kAXPositionAttribute), let sv = attr(el, kAXSizeAttribute) else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
    AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return s.width > 1 && s.height > 1 ? CGRect(origin: p, size: s) : nil
}

// Breadth-first through the app's controls; the first visible one whose description, title or
// value is exactly the name wins (buttons and tabs before plain text when both match).
func find(pid: pid_t, name: String) -> CGPoint? {
    // The app's windows only: the menu bar has its own "Help", "Window" and so on.
    let app = AXUIElementCreateApplication(pid)
    var queue: [AXUIElement] = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    var seen = 0
    var textHit: CGPoint?
    while !queue.isEmpty && seen < 40000 {
        let el = queue.removeFirst()
        seen += 1
        let labels = [kAXDescriptionAttribute, kAXTitleAttribute, kAXValueAttribute].compactMap { attr(el, $0) as? String }
        if labels.contains(name), let f = frame(el) {
            let role = attr(el, kAXRoleAttribute) as? String ?? ""
            let c = CGPoint(x: f.midX, y: f.midY)
            if role == "AXStaticText" { if textHit == nil { textHit = c } } else { return c }
        }
        if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids) }
    }
    return textHit
}

let a = CommandLine.arguments
func num(_ i: Int) -> Double { i < a.count ? Double(a[i]) ?? 0 : 0 }
guard a.count >= 2 else { FileHandle.standardError.write("usage: drive find|move|click|scroll|drag|trusted ...\n".data(using: .utf8)!); exit(2) }

switch a[1] {
case "trusted":
    print(AXIsProcessTrusted() ? "yes" : "no")
case "find":
    guard a.count == 4, let pid = Int32(a[2]) else { exit(2) }
    guard let p = find(pid: pid, name: a[3]) else { exit(1) }
    print("\(Int(p.x)) \(Int(p.y))")
case "move":
    glide(to: CGPoint(x: num(2), y: num(3)), ms: a.count > 4 ? num(4) : 450)
case "click":
    let p = CGPoint(x: num(2), y: num(3))
    glide(to: p, ms: 450)
    usleep(120_000)
    post(.leftMouseDown, p)
    usleep(90_000)
    post(.leftMouseUp, p)
case "scroll":
    if a.count >= 5 { glide(to: CGPoint(x: num(3), y: num(4)), ms: 300) }
    let lines = Int32(num(2))
    let step: Int32 = lines < 0 ? -1 : 1
    for _ in 0..<abs(lines) {
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: step, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
        usleep(45_000)
    }
case "drag":
    let p1 = CGPoint(x: num(2), y: num(3)), p2 = CGPoint(x: num(4), y: num(5))
    glide(to: p1, ms: 450)
    usleep(150_000)
    post(.leftMouseDown, p1)
    usleep(250_000)
    glide(to: p2, ms: 1100, dragging: true)
    usleep(250_000)
    post(.leftMouseUp, p2)
default:
    exit(2)
}
