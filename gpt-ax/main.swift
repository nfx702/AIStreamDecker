// AIStreamDeckerGPT: a deliberately dumb bridge between the ChatGPT app's accessibility tree and deck.mjs.
// All interpretation happens in JS, so this binary (and its Accessibility grant) never needs rebuilding.
//
//  writes  ~/.ai-deck/gpt-ax.json        every 1.5 s: [{d: depth, p: "0/3/1", r: role, s: subrole, t: title, x: description, v: value, u: url, c: dom classes}]
//  reads   ~/.ai-deck/gpt-ax-press.txt   a node path "0/3/1" -> AXPress on that element, then deletes the file
import Cocoa

func pathIndices(_ path: String) -> [Int]? {
  let parts = path.split(separator: "/", omittingEmptySubsequences: false)
  let indices = parts.compactMap { Int($0) }
  return !indices.isEmpty && indices.count == parts.count && indices.allSatisfy { $0 >= 0 } ? indices : nil
}
if CommandLine.arguments.contains("--self-test") {
  precondition(pathIndices("0/3/1") == [0, 3, 1])
  for invalid in ["", "-1", "0/-1", "0/nope/1", "0//1", "0/", "99999999999999999999999"] {
    precondition(pathIndices(invalid) == nil)
  }
  print("accessibility path checks ok")
  exit(0)
}

umask(0o077)
let dir = NSHomeDirectory() + "/.ai-deck"
let outFile = URL(fileURLWithPath: dir + "/gpt-ax.json")
let pressFile = dir + "/gpt-ax-press.txt"
let bundleId = "com.openai.codex"
let attrs = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXURL", "AXDOMClassList", "AXChildren"] as CFArray

try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir)
// `--prompt`: ask macOS for the Accessibility grant exactly once, then quit (install.mjs runs this once).
if CommandLine.arguments.contains("--prompt") {
  _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
  exit(0)
}
// The background job never prompts (a prompt per launch is unbearable): without the grant, report it and exit; launchd retries every ~10 s.
if !AXIsProcessTrusted() {
  try? #"{"trusted":false,"nodes":[]}"#.write(to: outFile, atomically: true, encoding: .utf8)
  Thread.sleep(forTimeInterval: 10)
  exit(0)
}

func fetch(_ e: AXUIElement) -> [Any] {
  var out: CFArray?
  AXUIElementCopyMultipleAttributeValues(e, attrs, [], &out)
  return (out as? [Any]) ?? []
}
func str(_ v: Any?) -> String? {
  if let s = v as? String, !s.isEmpty { return s }
  if let u = v as? URL { return u.absoluteString }
  return nil
}

func roots() -> [AXUIElement] {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { return [] }
  let el = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  var w: AnyObject?
  AXUIElementCopyAttributeValue(el, "AXWindows" as CFString, &w)
  return (w as? [AXUIElement]) ?? []
}

func element(at path: String) -> AXUIElement? {
  guard let idx = pathIndices(path), let first = idx.first else { return nil }
  let windows = roots()
  guard first < windows.count else { return nil }
  var e = windows[first]
  for i in idx.dropFirst() {
    guard let kids = fetch(e).last as? [AXUIElement], i < kids.count else { return nil }
    e = kids[i]
  }
  return e
}

while true {
  if let p = try? String(contentsOfFile: pressFile, encoding: .utf8) {
    try? FileManager.default.removeItem(atPath: pressFile)
    if let e = element(at: p.trimmingCharacters(in: .whitespacesAndNewlines)) { AXUIElementPerformAction(e, kAXPressAction as CFString) }
  }
  var nodes: [[String: Any]] = []
  func walk(_ e: AXUIElement, _ path: String, _ d: Int) {
    if d > 80 || nodes.count > 12000 { return }
    let v = fetch(e)
    guard v.count == 8 else { return }
    var n: [String: Any] = ["d": d, "p": path]
    for (k, i) in [("r", 0), ("s", 1), ("t", 2), ("x", 3), ("v", 4), ("u", 5)] { if let s = str(v[i]) { n[k] = s } }
    if let c = v[6] as? [String], !c.isEmpty { n["c"] = c.joined(separator: " ") }
    nodes.append(n)
    for (i, k) in ((v[7] as? [AXUIElement]) ?? []).enumerated() { walk(k, "\(path)/\(i)", d + 1) }
  }
  if AXIsProcessTrusted() { for (i, w) in roots().enumerated() { walk(w, "\(i)", 0) } }
  let doc: [String: Any] = ["trusted": AXIsProcessTrusted(), "at": Date().timeIntervalSince1970 * 1000, "nodes": nodes]
  if let data = try? JSONSerialization.data(withJSONObject: doc) { try? data.write(to: outFile, options: .atomic) }
  Thread.sleep(forTimeInterval: 1.5)
}
