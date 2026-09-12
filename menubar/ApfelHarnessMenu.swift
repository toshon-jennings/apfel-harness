import AppKit

// Apfel Harness Menu — tiny LSUIElement (menu-bar-only) helper.
// Zero dependencies, single file. Polls the harness /api/health and offers:
//   Open Apfel Harness · Restart Backend · Copy URL · Quit
// If the server is down, Open tries `launchctl kickstart` on the existing
// local.perci.apfel-harness LaunchAgent before opening the browser.

final class AppDelegate: NSObject, NSApplicationDelegate {
    static let harnessBase = URL(string: "http://127.0.0.1:6271")!
    static let healthURL = URL(string: "http://127.0.0.1:6271/api/health")!
    static let restartURL = URL(string: "http://127.0.0.1:6271/api/restart")!

    var statusItem: NSStatusItem!
    var statusLine: NSMenuItem!
    var timer: Timer?

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.behavior = .removalAllowed
        if let button = statusItem.button {
            button.target = nil
        }

        let menu = NSMenu()
        let open = NSMenuItem(title: "Open Apfel Harness", action: #selector(openHarness(_:)), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)

        statusLine = NSMenuItem(title: "Status: checking…", action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())

        let restart = NSMenuItem(title: "Restart Backend (apfel)", action: #selector(restartBackend(_:)), keyEquivalent: "r")
        restart.target = self
        menu.addItem(restart)

        let copy = NSMenuItem(title: "Copy URL", action: #selector(copyURL(_:)), keyEquivalent: "c")
        copy.target = self
        menu.addItem(copy)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit Menu Icon", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)

        statusItem.menu = menu
        setState("unknown", detail: "checking…")

        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }

    // MARK: - state

    // Rainbow apple from the harness favicon (public/index.html), drawn in
    // code so the menu app stays a single zero-dependency file. The badge
    // keeps the green/yellow/red state signal without any menu-bar text.
    static let appleStops: [(r: CGFloat, g: CGFloat, b: CGFloat)] = [
        (0.302, 0.651, 0.302),
        (0.910, 0.702, 0.165),
        (0.878, 0.478, 0.180),
        (0.816, 0.271, 0.271),
        (0.557, 0.306, 0.604),
        (0.180, 0.580, 0.788),
    ]

    func makeIcon(status: NSColor) -> NSImage {
        let pt: CGFloat = 20
        let img = NSImage(size: NSSize(width: pt, height: pt), flipped: false) { dst in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
        // Work in the favicon's 24x24 top-down units.
        ctx.scaleBy(x: pt / 24, y: pt / 24)
        ctx.translateBy(x: 0, y: 24)
        ctx.scaleBy(x: 1, y: -1)
        // Apple body: circle cx=12 cy=14 r=8, gradient green→blue top-down.
        let cgStops = Self.appleStops.map {
            NSColor(calibratedRed: $0.r, green: $0.g, blue: $0.b, alpha: 1).cgColor
        } as CFArray
        if let grad = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: cgStops,
            locations: [0, 0.2, 0.4, 0.6, 0.8, 1.0]
        ) {
            ctx.saveGState()
            ctx.addEllipse(in: CGRect(x: 4, y: 6, width: 16, height: 16))
            ctx.clip()
            ctx.drawLinearGradient(
                grad, start: CGPoint(x: 12, y: 6), end: CGPoint(x: 12, y: 22),
                options: [])
            ctx.restoreGState()
        }
        // Stem: M12 6 c0-3 2-4 3-4, stroked green.
        ctx.setStrokeColor(NSColor(calibratedRed: 0.302, green: 0.651, blue: 0.302, alpha: 1).cgColor)
        ctx.setLineWidth(2)
        ctx.setLineCap(.round)
        ctx.move(to: CGPoint(x: 12, y: 6))
        ctx.addCurve(to: CGPoint(x: 15, y: 2),
                    control1: CGPoint(x: 12, y: 3), control2: CGPoint(x: 14, y: 2))
        ctx.strokePath()
        // Status badge, bottom-right on the apple's edge.
        let badge = CGRect(x: 14.7, y: 15.5, width: 6.2, height: 6.2)
        ctx.setFillColor(status.cgColor)
        ctx.addEllipse(in: badge)
        ctx.fillPath()
        ctx.setStrokeColor(NSColor.white.cgColor)
        ctx.setLineWidth(1.1)
        ctx.addEllipse(in: badge)
        ctx.strokePath()
            return true
        }
        return img
    }

    func setState(_ state: String, detail: String) {
        guard let button = statusItem.button else { return }
        let dot: NSColor = switch state {
        case "online": .systemGreen
        case "starting": .systemYellow
        case "offline": .systemRed
        default: .systemGray
        }
        button.title = ""
        button.image = makeIcon(status: dot)
        button.toolTip = "Apfel Harness — \(detail)"
        statusLine.title = "Status: \(detail)"
    }

    func refresh() {
        var req = URLRequest(url: Self.healthURL, timeoutInterval: 4)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self else { return }
            var state = "offline"
            var detail = "server not running"
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            {
                let apfel = json["apfel"] as? [String: Any]
                state = (apfel?["state"] as? String) ?? "offline"
                let version = (json["version"] as? String) ?? ""
                let tools = ((json["mcp"] as? [String: Any])?["tools"] as? Int).map { " · \($0) tool\($0 == 1 ? "" : "s")" } ?? ""
                detail = state + (version.isEmpty ? "" : " · v\(version)") + tools
            }
            DispatchQueue.main.async { self.setState(state, detail: detail) }
        }.resume()
    }

    // MARK: - actions

    @objc func openHarness(_ sender: Any?) {
        // If the server answers, just open. Otherwise try to (re)start it via
        // the existing LaunchAgent, then open the browser anyway.
        var req = URLRequest(url: Self.healthURL, timeoutInterval: 1.5)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { head, _, _ in
            if head == nil {
                Self.kickstartServer()
                // Give node a moment to bind before the browser hits it.
                Thread.sleep(forTimeInterval: 1.5)
            }
            DispatchQueue.main.async {
                NSWorkspace.shared.open(Self.harnessBase)
            }
        }.resume()
    }

    @objc func restartBackend(_ sender: Any?) {
        var req = URLRequest(url: Self.restartURL, timeoutInterval: 5)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.refresh() }
        }.resume()
    }

    @objc func copyURL(_ sender: Any?) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(Self.harnessBase.absoluteString, forType: .string)
    }

    static func kickstartServer() {
        let uid = getuid()
        for target in ["gui/\(uid)/local.perci.apfel-harness", "local.perci.apfel-harness"] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            p.arguments = ["kickstart", target]
            try? p.run()
            p.waitUntilExit()
            if p.terminationStatus == 0 { return }
        }
        // Last resort: start node directly (LaunchAgent uses the same command).
        // Resolve node by absolute path — Process() gets launchd's minimal PATH
        // too, so bare "node" can fail even though a terminal finds it.
        let candidates = [
            NSHomeDirectory() + "/.hermes/node/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ]
        let nodePath = candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
            ?? "/usr/bin/env"  // last-ditch: let env try whatever PATH we do have
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        if nodePath == "/usr/bin/env" { p.arguments = ["node", NSHomeDirectory() + "/apfel-harness/server.js"] }
        else { p.arguments = [NSHomeDirectory() + "/apfel-harness/server.js"] }
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory() + "/apfel-harness")
        try? p.run()
    }
}

// Strong global ref — NSApplication.delegate is weak.
let apfelDelegate = AppDelegate()
NSApplication.shared.delegate = apfelDelegate
_ = NSApplicationMain(CommandLine.argc, CommandLine.unsafeArgv)
