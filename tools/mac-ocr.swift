// Reads the text in each picture of a folder with Apple's Vision framework and prints, for every
// phrase asked about, how many pictures show it and which ones: "<phrase>\t<count>\t<files>".
// tools/mac-check.sh uses it on the frames of a first-launch recording, so an error that shows for
// a third of a second is caught by a rule, not by someone scrubbing a video.
//
//   swiftc -O -o ocr tools/mac-ocr.swift && ./ocr <folder> "Could not load your usage" "Last 7 days"
import Foundation
import Vision
import ImageIO

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: ocr <folder of png> <phrase>...\n".data(using: .utf8)!)
    exit(2)
}
let dir = URL(fileURLWithPath: args[1])
let phrases = Array(args[2...])
let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
    .filter { $0.hasSuffix(".png") }
    .sorted()
var hits = [String: [String]]()
for p in phrases { hits[p] = [] }

for f in files {
    let url = dir.appendingPathComponent(f)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { continue }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    let text = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n").lowercased()
    for p in phrases where text.contains(p.lowercased()) { hits[p]!.append(f) }
}
print("frames\t\(files.count)")
for p in phrases { print("\(p)\t\(hits[p]!.count)\t\(hits[p]!.joined(separator: " "))") }
