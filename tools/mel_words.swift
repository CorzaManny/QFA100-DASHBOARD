import Foundation
import PDFKit
// Dumps every word with its position: page, x0, x1, top, bottom, text
let args = CommandLine.arguments
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else { print("cannot open"); exit(1) }
let re = try! NSRegularExpression(pattern: "\\S+")
var out = ""
for p in 0..<doc.pageCount {
    guard let page = doc.page(at: p), let str = page.string else { continue }
    let s = str as NSString
    let h = page.bounds(for: .mediaBox).height
    for m in re.matches(in: str, range: NSRange(location: 0, length: s.length)) {
        guard let sel = page.selection(for: m.range) else { continue }
        let b = sel.bounds(for: page)
        out += "\(p + 1)\t\(String(format: "%.1f\t%.1f\t%.1f\t%.1f", Double(b.minX), Double(b.maxX), Double(h - b.maxY), Double(h - b.minY)))\t\(s.substring(with: m.range))\n"
    }
}
try! out.write(toFile: args[2], atomically: true, encoding: .utf8)
print("done")
