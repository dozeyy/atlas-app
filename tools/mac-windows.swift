// Prints the on-screen windows of one process: "<window id> <x>,<y>,<w>,<h>" in screen points,
// one line each, for tools/mac-check.sh (screencapture -l <id> / -R <rect>). Needs no permission:
// owner pids, ids and bounds are public; only window titles would need screen recording.
//
//   swiftc -O -o winlist tools/mac-windows.swift && ./winlist <pid>
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) else {
    FileHandle.standardError.write("usage: winlist <pid>\n".data(using: .utf8)!)
    exit(2)
}
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
let list = (info as? [[String: Any]]) ?? []
for w in list {
    guard let owner = w[kCGWindowOwnerPID as String] as? Int32, owner == pid,
          let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
          let id = w[kCGWindowNumber as String] as? Int,
          let raw = w[kCGWindowBounds as String],
          let rect = CGRect(dictionaryRepresentation: raw as! CFDictionary) else { continue }
    print("\(id) \(Int(rect.origin.x)),\(Int(rect.origin.y)),\(Int(rect.width)),\(Int(rect.height))")
}
