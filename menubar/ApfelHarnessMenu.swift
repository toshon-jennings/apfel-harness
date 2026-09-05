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
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
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

    func setState(_ state: String, detail: String) {
        guard let button = statusItem.button else { return }
        let dot: NSColor = switch state {
        case "online": .systemGreen
        case "starting": .systemYellow
        case "offline": .systemRed
        default: .systemGray
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: dot,
            .font: NSFont.systemFont(ofSize: 13, weight: .black),
        ]
        let label = NSMutableAttributedString(string: "● ", attributes: attrs)
        label.append(NSAttributedString(
            string: "Apfel",
            attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .medium)]
        ))
        button.attributedTitle = label
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
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", NSHomeDirectory() + "/apfel-harness/server.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory() + "/apfel-harness")
        try? p.run()
    }
}

// Strong global ref — NSApplication.delegate is weak.
let apfelDelegate = AppDelegate()
NSApplication.shared.delegate = apfelDelegate
_ = NSApplicationMain(CommandLine.argc, CommandLine.unsafeArgv)
