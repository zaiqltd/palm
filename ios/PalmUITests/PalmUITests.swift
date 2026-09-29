import XCTest

/// End-to-end tests of the real app against an isolated test host started by
/// scripts/ios-ui-tests.mjs (simulated Mac, scripted agents, throwaway home
/// folder). Every test attaches screenshots for review.
final class PalmUITests: XCTestCase {
  private var host: String!

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard let value = ProcessInfo.processInfo.environment["PALM_UITEST_HOST"], !value.isEmpty else {
      throw XCTSkip("Run these through scripts/ios-ui-tests.mjs, which starts the isolated test host.")
    }
    host = value
    XCUIDevice.shared.orientation = .portrait
  }

  // MARK: Headers and tabs

  /// The top of each screen should read as one row, a
  /// title with its buttons, not a lone button above a large title.
  func testEachTabHasItsTitleAndButtonsOnOneRow() throws {
    let app = try launch()
    // Assistant · Agents · Files · Screen · More.
    XCTAssertEqual(app.tabBars.buttons.allElementsBoundByIndex.map(\.label), ["Assistant", "Agents", "Files", "Screen", "More"])
    XCTAssertTrue(barTitle(app, "Assistant").waitForExistence(timeout: 15), "The assistant comes first")
    snap(app, "tab-assistant")
    tab(app, "Agents")
    let agentsTitle = barTitle(app, "Agents")
    XCTAssertTrue(agentsTitle.waitForExistence(timeout: 15), "Agents title")
    let compose = app.buttons["agents.new"]
    XCTAssertTrue(compose.waitForExistence(timeout: 5))
    XCTAssertEqual(agentsTitle.frame.midY, compose.frame.midY, accuracy: 14, "Title and New task button share a row")
    XCTAssertLessThan(agentsTitle.frame.maxY, 130, "Title sits at the top")
    // Every tab names the computer it works on (E2E, 23 September: Files,
    // Screen and More did not).
    XCTAssertTrue(barTitle(app, "Sample Mac").waitForExistence(timeout: 5), "Agents names its computer")
    snap(app, "tab-agents")

    tab(app, "Screen")
    let screenTitle = barTitle(app, "Screen")
    XCTAssertTrue(screenTitle.waitForExistence(timeout: 10))
    XCTAssertLessThan(screenTitle.frame.maxY, 130)
    XCTAssertTrue(barTitle(app, "Sample Mac").waitForExistence(timeout: 5), "Screen names its computer")
    snap(app, "tab-screen")

    tab(app, "Files")
    XCTAssertTrue(barTitle(app, "Files").waitForExistence(timeout: 10))
    XCTAssertTrue(barTitle(app, "Sample Mac").waitForExistence(timeout: 5), "Files names its computer")
    XCTAssertTrue(app.buttons["files.send"].waitForExistence(timeout: 10))
    snap(app, "tab-files")

    tab(app, "More")
    XCTAssertTrue(barTitle(app, "More").waitForExistence(timeout: 10))
    XCTAssertTrue(barTitle(app, "Sample Mac").waitForExistence(timeout: 5), "More names its computer")
    snap(app, "tab-more")
    more(app, "Mac")
    XCTAssertTrue(barTitle(app, "Sample Mac").waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Sample Mac"].waitForExistence(timeout: 10) || app.staticTexts["SAMPLE MAC"].exists)
    snap(app, "tab-mac")
    app.swipeUp()
    snap(app, "tab-mac-lower")

    more(app, "Terminal")
    XCTAssertTrue(terminalElement(app).waitForExistence(timeout: 15), "A shell opens")
    snap(app, "tab-terminal")
  }

  // MARK: Terminal

  func testCameraAndMicStartAndStopOnTestHost() throws {
    let app = try launch()
    more(app, "media")
    XCTAssertTrue(barTitle(app, "Camera and mic").waitForExistence(timeout: 10))
    let picture = app.descendants(matching: .any)["media.picture"]
    let camera = app.staticTexts["media.cameraStatus"]
    let microphone = app.staticTexts["media.microphoneStatus"]
    let talk = app.staticTexts["media.talkStatus"]
    XCTAssertTrue(picture.waitForExistence(timeout: 5))
    XCTAssertEqual(picture.label, "Camera is off")
    XCTAssertEqual(camera.label, "Off")
    XCTAssertEqual(microphone.label, "Off")
    XCTAssertEqual(talk.label, "Off")
    app.buttons["media.start"].tap()
    XCTAssertTrue(app.buttons["media.stop"].waitForExistence(timeout: 15))
    let on = NSPredicate(format: "label == %@", "On")
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: on, object: camera)], timeout: 15), .completed)
    let live = NSPredicate(format: "label == %@", "Camera picture")
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: live, object: picture)], timeout: 15), .completed)
    // The sound is a WebRTC call (25 September). The test Mac only receives, so
    // no real microphone or speaker is used; its microphone stays "Waiting".
    XCTAssertTrue(waitForMediaValue(["transport", "client", "rtcConnected"], above: 0.5),
      "The phone's WebRTC call to the Mac must connect")
    XCTAssertTrue(waitForMediaValue(["native", "rtc", "rtcPacketsReceived"], above: 50),
      "Call audio must flow from the phone to the Mac")
    XCTAssertEqual(microphone.label, "Waiting")
    snap(app, "camera-and-mic-live-test-host")
    let mutedBytes = mediaValue(["native", "rtc", "rtcBytesReceived"]) ?? 0
    sleep(3)
    let mutedRate = ((mediaValue(["native", "rtc", "rtcBytesReceived"]) ?? 0) - mutedBytes) / 3
    app.buttons["media.talk"].tap()
    let talking = NSPredicate(format: "label == %@", "On")
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: talking, object: talk)], timeout: 15), .completed)
    XCTAssertEqual(camera.label, "On")
    sleep(1)
    let talkBytes = mediaValue(["native", "rtc", "rtcBytesReceived"]) ?? 0
    sleep(3)
    let talkRate = ((mediaValue(["native", "rtc", "rtcBytesReceived"]) ?? 0) - talkBytes) / 3
    XCTAssertGreaterThan(talkRate, max(5_000, mutedRate * 1.4),
      "Unmuted, the phone's test tone must reach the Mac (muted \(mutedRate) B/s, talking \(talkRate) B/s)")
    snap(app, "talk-to-mac-live-test-host")
    app.buttons["media.talk"].tap()
    XCTAssertEqual(talk.label, "Off")
    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(app.buttons["media.start"].waitForExistence(timeout: 10), "Backgrounding stops capture")
    XCTAssertEqual(camera.label, "Off")
    XCTAssertEqual(microphone.label, "Off")
    XCTAssertEqual(talk.label, "Off")
    app.buttons["media.start"].tap()
    XCTAssertTrue(app.buttons["media.stop"].waitForExistence(timeout: 15))
    app.buttons["media.stop"].tap()
    XCTAssertTrue(app.buttons["media.start"].waitForExistence(timeout: 5))
    XCTAssertEqual(picture.label, "Camera is off")
    XCTAssertEqual(camera.label, "Off")
    XCTAssertEqual(microphone.label, "Off")
    XCTAssertEqual(talk.label, "Off")
  }

  /// The shell opens in the home folder, the key bar never overlaps the tab
  /// bar or the screen edge, and what you type reaches the Mac.
  func testTerminalTypingKeyBarAndHomeFolder() throws {
    let app = try launch()
    more(app, "Terminal")
    let terminal = terminalElement(app)
    XCTAssertTrue(terminal.waitForExistence(timeout: 15))
    sleep(2)
    // Before typing: the terminal ends above the tab bar.
    let tabBar = app.tabBars.firstMatch
    if tabBar.exists {
      XCTAssertLessThanOrEqual(terminal.frame.maxY, tabBar.frame.minY + 1, "Terminal text must not run under the tab bar")
    }
    snap(app, "terminal-idle")

    terminal.tap()
    let hide = app.buttons["termbar.hide"]
    XCTAssertTrue(hide.waitForExistence(timeout: 10), "Key bar appears while typing")
    sleep(1)
    let screen = app.windows.firstMatch.frame
    XCTAssertLessThanOrEqual(hide.frame.maxY, screen.maxY - 8, "Key bar keys stay inside the safe area")
    XCTAssertGreaterThanOrEqual(hide.frame.maxX, screen.midX)
    XCTAssertLessThanOrEqual(hide.frame.maxX, screen.maxX - 8, "Keys clear the rounded corners")
    let agentsTab = app.tabBars.buttons["Agents"]
    XCTAssertFalse(agentsTab.exists && agentsTab.isHittable, "Nothing sits over the key bar while typing")
    XCTAssertLessThanOrEqual(terminal.frame.maxY, app.buttons["termbar.esc"].frame.minY + 1, "Terminal ends above the key bar")
    // E2E, 23 September: the arrows sat past the edge, behind the microphone.
    let termMicKey = app.buttons["termbar.mic"]
    for arrow in ["Up arrow", "Down arrow", "Left arrow", "Right arrow"] {
      XCTAssertLessThanOrEqual(app.buttons[arrow].frame.maxX, termMicKey.frame.minX, "\(arrow) is in view without scrolling")
    }
    // "if u open keyboard, u cant get off it". Done sits
    // in the top bar while typing.
    let done = app.buttons["terminal.done"]
    XCTAssertTrue(done.waitForExistence(timeout: 5), "Done shows while typing")
    XCTAssertLessThan(done.frame.maxY, 130, "Done is in the top bar")

    app.typeText("pwd > terminal-check.txt; echo palm-$((6*7)) >> terminal-check.txt\n")
    sleep(1)
    snap(app, "terminal-typing")

    // Sticky Control shows its state.
    let ctrl = app.buttons["termbar.ctrl"]
    ctrl.tap()
    XCTAssertEqual(ctrl.value as? String, "On")
    snap(app, "terminal-ctrl-latched")
    app.typeText("c")
    XCTAssertEqual(ctrl.value as? String, "Off", "Control releases after one key")

    // Three ways off the keyboard, each back to the tabs.
    let filesTab = app.tabBars.buttons["Files"]
    func assertKeyboardGone(_ how: String) {
      XCTAssertTrue(hide.waitForNonExistence(timeout: 5), "\(how) hides the keyboard")
      XCTAssertFalse(done.exists, "Done goes with the keyboard")
      sleep(1)
      XCTAssertTrue(filesTab.exists && filesTab.isHittable, "Tabs are reachable after \(how)")
    }
    done.tap()
    assertKeyboardGone("Done")
    snap(app, "terminal-after-typing")

    terminal.tap()
    XCTAssertTrue(hide.waitForExistence(timeout: 10))
    sleep(1)
    // Swiping the output down hides the keyboard.
    let from = terminal.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
    let to = terminal.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
    from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .fast, thenHoldForDuration: 0)
    assertKeyboardGone("Swiping down")

    terminal.tap()
    XCTAssertTrue(hide.waitForExistence(timeout: 10))
    sleep(1)
    hide.tap()
    assertKeyboardGone("The key bar's hide key")

    // The file the shell wrote is in the home folder, visible from Files.
    tab(app, "Files")
    app.buttons["files.save"].tap()
    let check = app.buttons["fs.terminal-check.txt"]
    XCTAssertTrue(check.waitForExistence(timeout: 10), "The shell started in the home folder")
    check.tap()
    let text = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "palm-42")).firstMatch
    XCTAssertTrue(text.waitForExistence(timeout: 10), "Typed command ran on the Mac")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/home")).firstMatch.exists)
    snap(app, "terminal-output-in-files")
  }

  // MARK: Agents

  func testAgentTaskStreamsAsksAndStops() throws {
    let app = try launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    app.buttons["agents.new"].tap()
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    XCTAssertTrue(message.waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["newtask.project"].label.contains("Home folder"), "New tasks start in the home folder")
    snap(app, "agent-new-task")
    message.tap()
    message.typeText("Say hello")
    app.buttons["newtask.start"].tap()

    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Test agent reply")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 20), "Streamed reply arrives")
    snap(app, "agent-reply")

    let composer = app.textViews["task.composer"].exists ? app.textViews["task.composer"] : app.textFields["task.composer"]
    composer.tap()
    composer.typeText("please approve this")
    app.buttons["task.send"].tap()
    // Swipe the keyboard away, as a person would to read the reply. Reading
    // the screen while a freshly installed keyboard warms up is very slow.
    app.scrollViews.firstMatch.swipeDown()
    let allow = app.buttons["approval.allow"]
    XCTAssertTrue(allow.waitForExistence(timeout: 15), "Approval request appears")
    snap(app, "agent-approval")
    allow.tap()
    let done = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "printed palm-test")).firstMatch
    XCTAssertTrue(done.waitForExistence(timeout: 15))
    snap(app, "agent-approved")

    composer.tap()
    composer.typeText("go slow")
    app.buttons["task.send"].tap()
    app.scrollViews.firstMatch.swipeDown()
    let stop = app.buttons["task.stop"]
    XCTAssertTrue(stop.waitForExistence(timeout: 10), "Stop appears while working")
    snap(app, "agent-working")
    stop.tap()
    let stopped = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Stopped")).firstMatch
    XCTAssertTrue(stopped.waitForExistence(timeout: 10), "Stop ends the step")
    snap(app, "agent-stopped")

    app.buttons["agents.strip.all"].tap()
    XCTAssertTrue(app.buttons["agents.task"].firstMatch.waitForExistence(timeout: 10) || app.cells.firstMatch.exists)
    snap(app, "agent-list")
  }

  /// More agents than Claude Code and Codex. Every agent
  /// installed on the Mac is offered; the test Mac has a scripted Grok.
  /// A PDF an agent makes can be fetched from its chat,
  /// as from the Assistant: a file card with Save to iPhone.
  func testAFileAnAgentMakesIsSavedFromItsChat() throws {
    let app = try launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    app.buttons["agents.new"].tap()
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    XCTAssertTrue(message.waitForExistence(timeout: 10))
    message.tap()
    message.typeText("make a pdf of this week")
    app.buttons["newtask.start"].tap()
    let card = app.staticTexts["palm-report.pdf"]
    XCTAssertTrue(card.waitForExistence(timeout: 20), "The PDF it made shows as a file in the chat")
    snap(app, "agent-file-card")
    let save = app.buttons["assistant.save"].firstMatch
    XCTAssertTrue(save.waitForExistence(timeout: 5))
    save.tap()
    XCTAssertTrue(app.staticTexts["On this iPhone, verified"].waitForExistence(timeout: 15), "Saved to the phone, checked by SHA-256")
    snap(app, "agent-file-saved")
    app.buttons["Done"].tap()
  }

  func testChoosingAnotherAgent() throws {
    let app = try launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    app.buttons["agents.new"].tap()
    let picker = app.buttons["newtask.provider"]
    XCTAssertTrue(picker.waitForExistence(timeout: 10))
    picker.tap()
    let grok = app.buttons["Grok"]
    XCTAssertTrue(grok.waitForExistence(timeout: 5), "Grok is offered alongside Claude Code and Codex")
    XCTAssertTrue(app.buttons["Codex"].exists && app.buttons["Claude Code"].exists)
    snap(app, "agent-choose")
    grok.tap()
    let signIn = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Uses its own sign-in")).firstMatch
    XCTAssertTrue(signIn.waitForExistence(timeout: 5), "It keeps its own sign-in")
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    message.tap()
    message.typeText("Say hello from another agent")
    snap(app, "agent-new-grok")
    app.buttons["newtask.start"].tap()
    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Test agent reply")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 20), "The other agent replies")
    XCTAssertTrue(barTitle(app, "Grok").exists, "The chat is labelled with the agent's name")
    app.buttons["agents.strip.all"].tap()
    let row = app.buttons.matching(identifier: "agents.task")
      .matching(NSPredicate(format: "label CONTAINS %@", "Say hello from another agent")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertTrue(row.label.contains("Grok"), "The list names the agent")
    snap(app, "agent-list-grok")
  }

  /// "u should be able to remove agent chats". A working
  /// chat is stopped and removed from its menu; a finished one swipes away.
  func testRemovingAgentChats() throws {
    let app = try launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    func startTask(_ text: String) {
      app.buttons["agents.new"].tap()
      let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
      XCTAssertTrue(message.waitForExistence(timeout: 10))
      message.tap()
      message.typeText(text)
      app.buttons["newtask.start"].tap()
    }
    func row(_ title: String) -> XCUIElement {
      app.buttons.matching(identifier: "agents.task").matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }

    // A working chat, removed from the list: it asks first, then stops it.
    // (The chat screen animates while an agent works, which makes every UI
    // test step there wait; the list does not.)
    startTask("Remove me while slow")
    XCTAssertTrue(app.buttons["task.stop"].waitForExistence(timeout: 15), "The chat is working")
    app.buttons["agents.strip.all"].tap()
    let working = row("Remove me while slow")
    XCTAssertTrue(working.waitForExistence(timeout: 10))
    working.swipeLeft()
    let swipeRemove = app.buttons["Remove"]
    XCTAssertTrue(swipeRemove.waitForExistence(timeout: 5))
    snap(app, "agent-remove-swipe")
    swipeRemove.tap()
    let confirm = app.buttons["Stop and remove"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 5), "A working chat asks first")
    snap(app, "agent-remove-confirm")
    confirm.tap()
    XCTAssertTrue(working.waitForNonExistence(timeout: 10), "The working chat is gone")

    // A finished chat, removed from its own menu.
    startTask("Remove me from the menu")
    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Test agent reply")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 20))
    app.buttons["task.options"].tap()
    let remove = app.buttons["task.remove"]
    XCTAssertTrue(remove.waitForExistence(timeout: 5))
    remove.tap()
    let confirmFinished = app.buttons["Remove"]
    XCTAssertTrue(confirmFinished.waitForExistence(timeout: 5))
    confirmFinished.tap()
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 10), "Back on the list")
    XCTAssertTrue(row("Remove me from the menu").waitForNonExistence(timeout: 10), "The finished chat is gone")
    snap(app, "agent-list-after-remove")
  }

  // MARK: Files

  func testFilesBrowseAndSaveToIPhone() throws {
    let app = try launch()
    tab(app, "Files")
    app.buttons["files.save"].tap()
    let documents = app.buttons["fs.Documents"]
    XCTAssertTrue(documents.waitForExistence(timeout: 10), "Browsing starts in the home folder")
    snap(app, "files-home")
    // Folders sorted smartly. Recent is the default; Name
    // lists folders A to Z.
    app.buttons["files.sort"].tap()
    let byName = app.buttons["Name"]
    XCTAssertTrue(byName.waitForExistence(timeout: 5))
    snap(app, "files-sort-menu")
    byName.tap()
    let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "fs."))
    XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
    XCTAssertEqual(rows.element(boundBy: 0).identifier, "fs.Desktop", "Name puts the folders A to Z")
    app.buttons["files.sort"].tap()
    XCTAssertTrue(app.buttons["Recent"].waitForExistence(timeout: 5))
    app.buttons["Recent"].tap()
    documents.tap()
    let notes = app.buttons["fs.notes.txt"]
    XCTAssertTrue(notes.waitForExistence(timeout: 10))
    notes.press(forDuration: 1.2)
    let save = app.buttons["Save to iPhone"]
    XCTAssertTrue(save.waitForExistence(timeout: 5))
    snap(app, "files-context-menu")
    save.tap()
    let verified = app.staticTexts["On this iPhone, verified"]
    XCTAssertTrue(verified.waitForExistence(timeout: 15), "Download verified by SHA-256")
    snap(app, "files-saved-to-iphone")
    app.buttons["Done"].tap()

    // E2E, 23 September: Add › Upload photos here closed the menu and nothing opened.
    let add = app.buttons["files.add"]
    XCTAssertTrue(add.waitForExistence(timeout: 5))
    add.tap()
    choose(app, "files.uploadPhotos")
    let photos = app.navigationBars["Photos"]
    let cancel = app.buttons["Cancel"]
    XCTAssertTrue(photos.waitForExistence(timeout: 10) || cancel.waitForExistence(timeout: 2), "The photo picker opens")
    snap(app, "files-upload-photos")
    if cancel.exists { cancel.tap() }
  }

  // MARK: Mac tab: dev server preview, clipboard, controls

  func testDevServerPreviewOpensOnThePhone() throws {
    let app = try launch()
    more(app, "Mac")
    let start = app.buttons["dev.start"]
    XCTAssertTrue(start.waitForExistence(timeout: 10))
    start.tap()
    let project = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "sample-site")).firstMatch
    XCTAssertTrue(project.waitForExistence(timeout: 10))
    project.tap()
    let script = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "npm run dev")).firstMatch
    XCTAssertTrue(script.waitForExistence(timeout: 5))
    snap(app, "dev-start")
    script.tap()

    let preview = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "dev.preview.")).firstMatch
    XCTAssertTrue(preview.waitForExistence(timeout: 20))
    let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: preview)
    wait(for: [enabled], timeout: 30)
    snap(app, "dev-running")
    preview.tap()
    let page = app.webViews.staticTexts["Hello from the sample site"]
    XCTAssertTrue(page.waitForExistence(timeout: 20), "The dev server's page renders on the phone")
    snap(app, "dev-preview")
    app.buttons["Done"].tap()
  }

  func testClipboardAndMacControls() throws {
    let app = try launch()
    more(app, "Mac")
    let get = app.buttons["clipboard.get"]
    XCTAssertTrue(get.waitForExistence(timeout: 10))
    get.tap()
    XCTAssertTrue(app.staticTexts["synthetic clipboard"].waitForExistence(timeout: 10), "Mac clipboard text arrives")
    snap(app, "mac-clipboard")
    app.swipeUp()
    let lock = app.buttons["Lock"]
    XCTAssertTrue(lock.waitForExistence(timeout: 5))
    lock.tap()
    XCTAssertTrue(app.staticTexts["Lock your Mac?"].waitForExistence(timeout: 5), "Lock asks first")
    snap(app, "mac-lock-confirm")
    // The test host only simulates the lock.
    app.buttons["confirm.action"].firstMatch.tap()
    let done = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "nothing was locked")).firstMatch
    XCTAssertTrue(done.waitForExistence(timeout: 10), "The result is reported")
    snap(app, "mac-lock-done")

    // Sleep later: set a timer, see when, cancel it (the test host never sleeps).
    _ = app.otherElements["toast.notice"].waitForNonExistence(timeout: 8)
    let later = app.buttons["mac.sleepLater"]
    XCTAssertTrue(later.waitForExistence(timeout: 5))
    later.tap()
    let inHour = app.buttons["1 hour"]
    if !inHour.waitForExistence(timeout: 5) {
      let dump = XCTAttachment(string: app.debugDescription)
      dump.name = "debug-sleep-menu"
      dump.lifetime = .keepAlways
      add(dump)
    }
    XCTAssertTrue(inHour.exists)
    inHour.tap()
    let cancel = app.buttons["mac.cancelSleep"]
    XCTAssertTrue(cancel.waitForExistence(timeout: 10), "The timer shows with a Cancel button")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Sleeps at")).firstMatch.exists)
    snap(app, "mac-sleep-timer")
    cancel.tap()
    XCTAssertTrue(app.buttons["mac.sleepLater"].waitForExistence(timeout: 10), "Cancelled")

    // Keyboard light (simulated on the test host).
    app.swipeDown()
    let keyboardLight = app.sliders["mac.keyboardLight"]
    XCTAssertTrue(keyboardLight.waitForExistence(timeout: 5), "Keyboard light slider")
    keyboardLight.adjust(toNormalizedSliderPosition: 0.2)
    snap(app, "mac-keyboard-light")
  }

  // MARK: Live screen

  func testLiveScreenControlsAndTypingBar() throws {
    let app = try launch()
    tab(app, "Screen")
    let desktop = app.buttons["screen.desktop"]
    XCTAssertTrue(desktop.waitForExistence(timeout: 10))
    desktop.tap()
    let keyboard = app.buttons["remote.keyboard"]
    XCTAssertTrue(keyboard.waitForExistence(timeout: 15))
    sleep(2)
    snap(app, "remote-touch")
    let portraitWindow = app.windows.firstMatch.frame
    let cornerMap = app.images["remote.overview"]
    if cornerMap.exists && !cornerMap.frame.isEmpty {
      XCTAssertLessThan(cornerMap.frame.minY, 40, "The zoom map sits in the top corner")
      XCTAssertGreaterThan(cornerMap.frame.maxX, portraitWindow.maxX - 30)
    }
    // Copy and paste must be ultra simple. A double tap
    // selects the word on the Mac and Copy / Paste appear by the finger.
    let picture = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Live Mac screen")).firstMatch
    XCTAssertTrue(picture.exists)
    picture.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).doubleTap()
    let copy = app.buttons["remote.copy"]
    XCTAssertTrue(copy.waitForExistence(timeout: 5), "Copy appears after a double tap")
    XCTAssertTrue(app.buttons["remote.selectAll"].exists)
    snap(app, "remote-copy-paste")
    copy.tap()
    XCTAssertTrue(app.staticTexts["Copied"].waitForExistence(timeout: 5), "Copy confirms")
    XCTAssertTrue(copy.waitForNonExistence(timeout: 5))
    app.buttons["remote.mode.mouse"].tap()
    XCTAssertTrue(app.buttons["remote.mode.mouse"].isSelected)
    snap(app, "remote-mouse")
    keyboard.tap()
    let hide = app.buttons["keybar.hide"]
    XCTAssertTrue(hide.waitForExistence(timeout: 10), "Typing key bar appears")
    let screen = app.windows.firstMatch.frame
    XCTAssertLessThanOrEqual(hide.frame.maxY, screen.maxY - 8)
    XCTAssertLessThanOrEqual(hide.frame.maxX, screen.maxX - 8)
    let command = app.buttons["keybar.cmd"]
    // E2E, 23 September: ⌘ was only a sliver beside the microphone.
    XCTAssertLessThanOrEqual(command.frame.maxX, app.buttons["keybar.mic"].frame.minX, "⌘ is in view without scrolling")
    command.tap()
    XCTAssertEqual(command.value as? String, "On", "Latched modifier shows its state")
    let done = app.buttons["remote.done"]
    XCTAssertTrue(done.waitForExistence(timeout: 5), "Done shows while typing")
    XCTAssertLessThan(done.frame.maxY, 130, "Done is in the top bar")
    let map = app.images["remote.overview"]
    if map.exists && !map.frame.isEmpty {
      XCTAssertFalse(done.frame.intersects(map.frame), "Done does not cover the zoom map")
    }
    snap(app, "remote-typing")
    command.tap()
    done.tap()
    XCTAssertTrue(hide.waitForNonExistence(timeout: 5), "Done hides the keyboard")
    XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
    XCTAssertFalse(done.exists)
    keyboard.tap()
    XCTAssertTrue(hide.waitForExistence(timeout: 10))
    hide.tap()
    XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
    snap(app, "remote-after-typing")

    // Landscape: the controls move into a rail in the side margin.
    XCUIDevice.shared.orientation = .landscapeLeft
    let rail = app.otherElements["remote.rail"]
    XCTAssertTrue(app.buttons["remote.stop"].waitForExistence(timeout: 10))
    sleep(2)
    let window = app.windows.firstMatch.frame
    XCTAssertGreaterThan(app.buttons["remote.stop"].frame.midX, window.midX, "Rail on the right by default")
    XCTAssertGreaterThan(app.buttons["remote.keyboard"].frame.minY, app.buttons["remote.back"].frame.maxY,
      "The rail runs down the side")
    // The red Stop was cut off. The rail floats over a
    // full-screen picture and every control fits the screen's height.
    let stopButton = app.buttons["remote.stop"]
    XCTAssertLessThanOrEqual(stopButton.frame.maxY, window.maxY - 4, "Stop is fully on screen")
    XCTAssertGreaterThanOrEqual(app.buttons["remote.back"].frame.minY, window.minY + 4)
    XCTAssertTrue(stopButton.isHittable)
    let sideMap = app.images["remote.overview"]
    if sideMap.exists && !sideMap.frame.isEmpty {
      XCTAssertLessThanOrEqual(sideMap.frame.maxX, rail.frame.minX, "The zoom map sits beside the rail, not under it")
    }
    // "move it more to the right". With the island on
    // the other side, the rail sits close to the edge.
    XCTAssertGreaterThanOrEqual(rail.frame.maxX, window.maxX - 20, "The rail hugs the right edge")
    let landscapeRail = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    landscapeRail.name = "remote-landscape-edge"
    landscapeRail.lifetime = .keepAlways
    add(landscapeRail)

    // It tucks away to a tab and comes back.
    app.buttons["remote.hideControls"].tap()
    let showControls = app.buttons["remote.showControls"]
    XCTAssertTrue(showControls.waitForExistence(timeout: 5), "A tab stays at the edge")
    XCTAssertFalse(app.buttons["remote.stop"].exists, "The rail is tucked away")
    XCTAssertGreaterThanOrEqual(showControls.frame.maxX, window.maxX - 20)
    if sideMap.exists && !sideMap.frame.isEmpty {
      XCTAssertGreaterThan(sideMap.frame.maxX, window.maxX - 30, "With the rail away, the zoom map takes the corner")
    }
    let tucked = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    tucked.name = "remote-landscape-tucked"
    tucked.lifetime = .keepAlways
    add(tucked)
    showControls.tap()
    XCTAssertTrue(app.buttons["remote.stop"].waitForExistence(timeout: 5), "The rail comes back")

    // Turned the other way, the island is on the right: the rail stays clear of it.
    XCUIDevice.shared.orientation = .landscapeRight
    sleep(2)
    let turned = app.windows.firstMatch.frame
    XCTAssertLessThanOrEqual(rail.frame.maxX, turned.maxX - 50, "The rail stays clear of the Dynamic Island")
    XCTAssertLessThanOrEqual(app.buttons["remote.stop"].frame.maxY, turned.maxY - 4)
    let islandSide = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    islandSide.name = "remote-landscape-island-side"
    islandSide.lifetime = .keepAlways
    add(islandSide)
    // The app's own screenshot comes out rotated in landscape; the device
    // screen capture does not.
    let landscapeShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    landscapeShot.name = "remote-landscape-rail"
    landscapeShot.lifetime = .keepAlways
    add(landscapeShot)
    XCUIDevice.shared.orientation = .portrait
  }

  /// Tapping an app opens it in full. Its window fills
  /// the Mac screen and the phone shows the whole of it.
  func testOpeningAnAppShowsTheWholeWindow() throws {
    let app = try launch()
    tab(app, "Screen")
    let editor = app.buttons["apps.open.test.editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    editor.tap()
    let zoom = app.buttons["remote.zoom"]
    XCTAssertTrue(zoom.waitForExistence(timeout: 15))
    sleep(2)
    XCTAssertEqual(zoom.label, "Zoom in", "The whole window shows, not a zoomed-in part")
    snap(app, "remote-app-whole")
    app.buttons["remote.options"].tap()
    let fill = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "Fill the Mac screen", "Fill the Mac screen"))
      .firstMatch
    XCTAssertTrue(fill.waitForExistence(timeout: 5), "Opening an app fills the Mac screen")
    snap(app, "remote-app-options")
  }

  // MARK: Assistant

  /// Assistant → the right file → a usable result on the phone, not directions.
  func testAssistantFindsAFileAndSavesItToThePhone() throws {
    let app = try launch()
    XCTAssertTrue(assistantInput(app).waitForExistence(timeout: 15), "The assistant is the first tab")
    snap(app, "assistant-empty")
    ask(app, "Find my notes")
    XCTAssertTrue(app.descendants(matching: .any)["assistant.card.file"].waitForExistence(timeout: 15), "A file result")
    XCTAssertTrue(app.staticTexts["notes.txt"].exists)
    snap(app, "assistant-file")
    app.buttons["assistant.save"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["On this iPhone, verified"].waitForExistence(timeout: 15), "Saved and checked")
    snap(app, "assistant-saved")
  }

  /// From a real screenshot: said plainly, without "find", the
  /// Assistant still finds the file; "Check downloads" shows Downloads.
  func testAssistantHelpsWithPlainWords() throws {
    let app = try launch()
    ask(app, "What I need is yesterday's daily log that I got for my boss.")
    XCTAssertTrue(app.staticTexts["Daily log 22 Sep.txt"].waitForExistence(timeout: 30), "The log, found by the model's search")
    XCTAssertTrue(app.buttons["assistant.save"].firstMatch.exists)
    snap(app, "assistant-plain-words")
    ask(app, "Check downloads")
    XCTAssertTrue(app.staticTexts["boarding-pass.pdf"].waitForExistence(timeout: 15), "Downloads, newest first")
    snap(app, "assistant-downloads")
  }

  /// Priorities 1 and 2 (23 September): a named target is never swapped; the
  /// conversation's results are remembered; work the Assistant cannot do is
  /// offered to an agent, and the agent's verified file comes back to the phone.
  func testAssistantTargetsContextAndHandOff() throws {
    let app = try launch()
    let clear = app.buttons["assistant.clear"]
    if clear.waitForExistence(timeout: 5) { clear.tap() }

    ask(app, "Open the nonexistent billing website preview")
    let choice = app.buttons.matching(identifier: "assistant.choice").matching(NSPredicate(format: "label CONTAINS %@", "sample-site")).firstMatch
    XCTAssertTrue(choice.waitForExistence(timeout: 15), "No other project was started; choices instead")
    snap(app, "assistant-choices")
    choice.tap()
    XCTAssertTrue(app.buttons["assistant.openPreview"].waitForExistence(timeout: 20), "The chosen project's preview")

    ask(app, "Open my website preview on my other Mac")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "paired with one computer")).firstMatch.waitForExistence(timeout: 15),
      "Another computer is never replaced by this one")

    ask(app, "Find my notes")
    XCTAssertTrue(app.staticTexts["notes.txt"].waitForExistence(timeout: 15))
    ask(app, "send me that file")
    XCTAssertTrue(app.staticTexts["On this iPhone, verified"].waitForExistence(timeout: 15), "That file, saved to the phone")
    snap(app, "assistant-that-file")
    app.buttons["Done"].firstMatch.tap()

    ask(app, "find my latest proposal, export it as a PDF and bring it to my phone")
    let handoff = app.buttons["assistant.handoff"]
    XCTAssertTrue(handoff.waitForExistence(timeout: 20), "It asks before an agent starts")
    snap(app, "assistant-handoff")
    handoff.tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "is on it")).firstMatch.waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["On this iPhone, verified"].waitForExistence(timeout: 40), "The agent's PDF, checked and on the phone")
    snap(app, "assistant-agent-result")
    app.buttons["Done"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Proposal - Acme.pdf"].waitForExistence(timeout: 10))
    // The same session is in Agents.
    tab(app, "Agents")
    XCTAssertTrue(app.buttons.matching(identifier: "agents.strip.chip").matching(NSPredicate(format: "label CONTAINS %@", "Export")).firstMatch.waitForExistence(timeout: 10))
  }

  /// Beside an agent's chat the screen had no way to type,
  /// no key bar and no apps, and an agent without the screen could not be
  /// given it there. Now it has the Screen tab's controls, typing reaches the
  /// Mac, Spotlight is one tap, and the pane offers the screen to the agent.
  func testScreenBesideAnAgentHasItsControls() throws {
    let app = try launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    app.buttons["agents.new"].tap()
    // Started without the screen, to give it from beside the chat.
    let screenSwitch = app.switches["Let it use the Mac screen"]
    XCTAssertTrue(screenSwitch.waitForExistence(timeout: 10))
    if screenSwitch.value as? String == "1" { flip(screenSwitch) }
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    message.tap()
    message.typeText("Screen side by side")
    app.buttons["newtask.start"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Test agent reply")).firstMatch.waitForExistence(timeout: 20))
    app.buttons["task.screen"].tap()
    let allow = app.buttons["task.screen.allow"]
    XCTAssertTrue(allow.waitForExistence(timeout: 15), "Without the screen, the pane offers it to the agent")
    allow.tap()
    XCTAssertTrue(allow.waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Screen control allowed")).firstMatch.waitForExistence(timeout: 10), "and the chat says so")
    // The Screen tab's controls, beside the chat.
    let keyboard = app.buttons["task.screen.keyboard"]
    XCTAssertTrue(keyboard.waitForExistence(timeout: 15))
    XCTAssertTrue(app.buttons["task.screen.mode"].exists && app.buttons["task.screen.mic"].exists && app.buttons["task.screen.apps"].exists)
    snap(app, "session-screen-controls")
    keyboard.tap()
    let hide = app.buttons["keybar.hide"]
    XCTAssertTrue(hide.waitForExistence(timeout: 10), "The keyboard with its key bar")
    app.typeText("hello mac")
    XCTAssertTrue(waitForTyping { typedText($0).contains("hello mac") }, "What was typed reached the Mac: \(typedText(typingOnHost()))")
    snap(app, "session-screen-typing")
    hide.tap()
    XCTAssertTrue(hide.waitForNonExistence(timeout: 5))
    // Apps and Spotlight.
    app.buttons["task.screen.apps"].tap()
    XCTAssertTrue(app.buttons.matching(identifier: "apps.running").matching(NSPredicate(format: "label CONTAINS %@", "Sample Editor")).firstMatch.waitForExistence(timeout: 10), "The Mac's open apps")
    XCTAssertTrue(app.buttons.matching(identifier: "apps.installed").matching(NSPredicate(format: "label CONTAINS %@", "Sample Notes")).firstMatch.waitForExistence(timeout: 10), "and the others it has")
    snap(app, "screen-apps")
    app.buttons["apps.shortcut.spotlight"].tap()
    XCTAssertTrue(waitForTyping { events in
      events.contains { $0["key"] as? String == "space" && ($0["modifiers"] as? [String]) == ["cmd"] }
    }, "Spotlight opened on the Mac")
    XCTAssertTrue(hide.waitForExistence(timeout: 10), "with the keyboard up to type what to find")
  }

  /// "the agent open it and watch screen thing doesnt
  /// work". An agent allowed the screen uses it, the chat says so with Watch,
  /// and watching shows it working, with Take over and Hand back.
  func testWatchingAnAgentUseTheScreen() throws {
    let app = try launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    app.buttons["agents.new"].tap()
    let screenSwitch = app.switches["Let it use the Mac screen"]
    XCTAssertTrue(screenSwitch.waitForExistence(timeout: 10))
    XCTAssertEqual(screenSwitch.value as? String, "1", "On unless turned off")
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    message.tap()
    message.typeText("Open the browser and use the screen")
    app.buttons["newtask.start"].tap()
    let watch = app.buttons["task.watchScreen"]
    XCTAssertTrue(watch.waitForExistence(timeout: 20), "The chat says the agent is using the screen")
    snap(app, "agent-using-screen")
    watch.tap()
    let takeOver = app.buttons["task.takeover"]
    XCTAssertTrue(takeOver.waitForExistence(timeout: 15), "Watching it work, with Take over")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Agent is using the screen")).firstMatch.exists)
    snap(app, "agent-screen-watch")
    takeOver.tap()
    let handBack = app.buttons["task.handback"]
    XCTAssertTrue(handBack.waitForExistence(timeout: 10), "Taken over")
    XCTAssertTrue(app.buttons["task.screen.keyboard"].isEnabled, "and the controls are the user's")
    handBack.tap()
    XCTAssertTrue(handBack.waitForNonExistence(timeout: 10), "Handed back")
    let stop = app.buttons["task.stop"]
    if stop.exists { stop.tap() }
  }

  /// With several monitors, switch between them from the
  /// phone. The test Mac has two screens; the name at the top lists them.
  func testSwitchingMacScreens() throws {
    let app = try launch()
    tab(app, "Screen")
    let desktop = app.buttons["screen.desktop"]
    XCTAssertTrue(desktop.waitForExistence(timeout: 10))
    desktop.tap()
    let screens = app.buttons["remote.displays"]
    XCTAssertTrue(screens.waitForExistence(timeout: 15), "Two screens: the name at the top lists them")
    sleep(1)
    screens.tap()
    let studio = app.buttons["Studio Display"]
    XCTAssertTrue(studio.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Built-in Display"].exists)
    snap(app, "remote-screens")
    studio.tap()
    let showing = NSPredicate(format: "value == %@", "Studio Display")
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: showing, object: screens)], timeout: 15), .completed, "Showing the other screen")
    XCTAssertTrue(waitForTyping { events in
      events.contains { $0["op"] as? String == "start" && ($0["displayId"] as? Int) == 2 }
    }, "The Mac was asked for that screen")
  }

  /// "I shouldn't have to leave the screen control to get
  /// something from my phone clipboard onto my laptop". Paste leads the key bar
  /// and puts this iPhone's copied text on the Mac's clipboard, then ⌘V.
  func testKeyBarPastesFromThePhone() throws {
    UIPasteboard.general.string = "copied on the iPhone"
    let app = try launch()
    tab(app, "Screen")
    let desktop = app.buttons["screen.desktop"]
    XCTAssertTrue(desktop.waitForExistence(timeout: 10))
    desktop.tap()
    let keyboard = app.buttons["remote.keyboard"]
    XCTAssertTrue(keyboard.waitForExistence(timeout: 15))
    sleep(1)
    keyboard.tap()
    let paste = app.descendants(matching: .any)["keybar.paste"]
    XCTAssertTrue(paste.waitForExistence(timeout: 10), "Paste leads the key bar")
    XCTAssertTrue(app.buttons["keybar.photo"].exists, "with Photo beside it")
    snap(app, "keybar-paste")
    paste.tap()
    XCTAssertTrue(waitForTyping { events in
      events.contains { $0["op"] as? String == "clipboardWrite" && ($0["text"] as? String) == "copied on the iPhone" }
        && events.contains { $0["key"] as? String == "v" && ($0["modifiers"] as? [String]) == ["cmd"] }
    }, "On the Mac's clipboard, then pasted")
  }

  /// "a button that opens up the Mac's bottom or top nav
  /// bar". The Dock and the menu bar are one tap from the screen's controls:
  /// the pointer goes to that edge (an auto-hidden bar slides out) and the
  /// view shows it at a readable size.
  func testDockAndMenuBarButton() throws {
    let app = try launch()
    tab(app, "Screen")
    let desktop = app.buttons["screen.desktop"]
    XCTAssertTrue(desktop.waitForExistence(timeout: 10))
    desktop.tap()
    let edges = app.buttons["remote.edges"]
    XCTAssertTrue(edges.waitForExistence(timeout: 15), "The Dock and menu bar button")
    sleep(1)
    edges.tap()
    XCTAssertTrue(app.buttons["Dock"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Menu bar"].exists)
    snap(app, "remote-edges-menu")
    choose(app, "Dock")
    // The Mac's own Dock, at a size a finger can use; an item does what a click in the Dock does.
    let item = app.buttons.matching(identifier: "dock.item").matching(NSPredicate(format: "label CONTAINS %@", "Downloads")).firstMatch
    XCTAssertTrue(item.waitForExistence(timeout: 10), "The Dock's items, from the Dock itself")
    snap(app, "remote-dock-sheet")
    item.tap()
    XCTAssertTrue(waitForTyping { events in
      events.contains { $0["op"] as? String == "dockPress" && ($0["index"] as? Int) == 2 }
    }, "Pressed in the Mac's Dock")
    XCTAssertTrue(item.waitForNonExistence(timeout: 5), "The Dock list closes")
    // The real Dock on the screen is one more tap away.
    XCTAssertTrue(edges.waitForExistence(timeout: 5))
    sleep(1)
    edges.tap()
    choose(app, "Dock")
    let onScreen = app.buttons["dock.showOnScreen"]
    XCTAssertTrue(onScreen.waitForExistence(timeout: 10))
    onScreen.tap()
    XCTAssertTrue(onScreen.waitForNonExistence(timeout: 5), "The Dock list closes")
    XCTAssertTrue(waitForTyping { events in
      events.contains { $0["op"] as? String == "revealEdge" && $0["edge"] as? String == "bottom" }
    }, "The pointer is pushed against the bottom edge: a hidden Dock slides out, or comes over from the other screen")
    snap(app, "remote-dock")
    XCTAssertTrue(edges.waitForExistence(timeout: 5))
    sleep(1)
    edges.tap()
    choose(app, "Menu bar")
    XCTAssertTrue(waitForTyping { events in
      events.contains { $0["op"] as? String == "revealEdge" && $0["edge"] as? String == "top" }
    }, "and against the top edge for the menu bar")
    snap(app, "remote-menu-bar")
  }

  /// In a chat with the screen beside it, the keyboard
  /// could not be put away. A button beside the message puts it away.
  func testChatKeyboardCanBePutAway() throws {
    let app = try launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    app.buttons["agents.new"].tap()
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    XCTAssertTrue(message.waitForExistence(timeout: 10))
    message.tap()
    message.typeText("Keyboard test")
    app.buttons["newtask.start"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Test agent reply")).firstMatch.waitForExistence(timeout: 20))
    app.buttons["task.screen"].tap()
    let composer = app.textViews["task.composer"].exists ? app.textViews["task.composer"] : app.textFields["task.composer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    composer.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "Typing a message")
    let hide = app.buttons["task.hideKeyboard"]
    XCTAssertTrue(hide.waitForExistence(timeout: 5), "A button puts the keyboard away")
    snap(app, "chat-keyboard-hide")
    hide.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "The keyboard is gone")
    XCTAssertFalse(hide.exists)
  }

  /// Scrolling felt the wrong way round. "Invert
  /// scrolling" (the screen's options and More › Preferences) reverses what
  /// the same swipe does on the Mac.
  func testInvertScrolling() throws {
    let app = try launch()
    tab(app, "Screen")
    let desktop = app.buttons["screen.desktop"]
    XCTAssertTrue(desktop.waitForExistence(timeout: 10))
    desktop.tap()
    XCTAssertTrue(app.buttons["remote.keyboard"].waitForExistence(timeout: 15))
    sleep(1)
    let picture = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Live Mac screen")).firstMatch
    picture.swipeUp()
    XCTAssertTrue(waitForTyping { self.lastScroll($0) != nil }, "A swipe scrolls the Mac")
    let before = lastScroll(typingOnHost()) ?? 0
    app.buttons["remote.options"].tap()
    let toggle = app.switches["remote.invertScroll"]
    XCTAssertTrue(toggle.waitForExistence(timeout: 5), "Invert scrolling in the screen's options")
    flip(toggle)
    XCTAssertEqual(toggle.value as? String, "1")
    app.buttons["Done"].firstMatch.tap()
    sleep(1)
    picture.swipeUp()
    XCTAssertTrue(waitForTyping { events in (self.lastScroll(events) ?? 0) * before < 0 }, "The same swipe now scrolls the other way")
    snap(app, "remote-invert-scroll")
    app.buttons["remote.back"].firstMatch.tap()
    more(app, "Preferences")
    let preference = app.switches["prefs.invertScroll"]
    _ = preference.waitForExistence(timeout: 10)
    for _ in 0..<6 where !(preference.exists && preference.isHittable) { app.swipeUp() }
    XCTAssertEqual(preference.value as? String, "1", "The same setting in Preferences")
  }

  /// The full Screen: an app is one tap from the Apps sheet, and Spotlight
  /// shows the whole screen with the keyboard ready.
  func testScreenAppsAndSpotlight() throws {
    let app = try launch()
    tab(app, "Screen")
    let desktop = app.buttons["screen.desktop"]
    XCTAssertTrue(desktop.waitForExistence(timeout: 10))
    desktop.tap()
    let apps = app.buttons["remote.apps"]
    XCTAssertTrue(apps.waitForExistence(timeout: 15))
    sleep(1)
    apps.tap()
    let browser = app.buttons.matching(identifier: "apps.running").matching(NSPredicate(format: "label CONTAINS %@", "Sample Browser")).firstMatch
    XCTAssertTrue(browser.waitForExistence(timeout: 10), "Open apps, with their icons")
    browser.tap()
    XCTAssertTrue(app.staticTexts["Sample Browser"].waitForExistence(timeout: 15), "That app is on screen")
    XCTAssertTrue(apps.waitForExistence(timeout: 10))
    apps.tap()
    let spotlight = app.buttons["apps.shortcut.spotlight"]
    XCTAssertTrue(spotlight.waitForExistence(timeout: 10))
    spotlight.tap()
    XCTAssertTrue(app.staticTexts["Sample Browser"].exists, "No jump to another view: the whole screen is already shown")
    XCTAssertTrue(waitForTyping { events in
      events.contains { $0["key"] as? String == "space" && ($0["modifiers"] as? [String]) == ["cmd"] }
    }, "Spotlight opened on the Mac")
    XCTAssertTrue(app.buttons["remote.done"].waitForExistence(timeout: 10), "The keyboard is up to type what to find")
    // E2E, 23 September: zoomed elsewhere, the search box was out of view. The
    // view goes to it (top centre, readable): zoomed in, the map shows.
    let map = app.images["remote.overview"]
    XCTAssertTrue(map.waitForExistence(timeout: 5) && !map.frame.isEmpty, "The view is on Spotlight's box")
    snap(app, "remote-spotlight")
  }

  /// Priority 4: the paid OpenRouter route is off until switched on, takes a
  /// model and limits, is chosen by name like any agent, and its sessions say
  /// they are paid per use. Switched off, it is no longer offered. (The test
  /// Mac's route uses stand-in models and usage, never the network.)
  func testOpenRouterRouteIsChosenAndMarkedPaid() throws {
    let app = try launch()
    more(app, "Preferences")
    let toggle = app.switches["prefs.route.enabled"]
    _ = toggle.waitForExistence(timeout: 10)
    for _ in 0..<6 where !(toggle.exists && toggle.isHittable) { app.swipeUp() }
    XCTAssertTrue(toggle.waitForExistence(timeout: 5), "The paid route is in Preferences")
    XCTAssertEqual(toggle.value as? String, "0", "Off until chosen")
    flip(toggle)
    let model = app.buttons["prefs.route.model"]
    XCTAssertTrue(model.waitForExistence(timeout: 10), "Switched on, it takes a model")
    XCTAssertTrue(app.buttons["prefs.route.daily"].exists && app.buttons["prefs.route.session"].exists, "and limits")
    let usage = app.staticTexts["prefs.route.usage"]
    XCTAssertTrue(usage.waitForExistence(timeout: 5))
    XCTAssertTrue(usage.label.contains("today $0.12"), "What the key has spent: \(usage.label)")
    model.tap()
    let coder = app.buttons.matching(identifier: "route.model").matching(NSPredicate(format: "label CONTAINS %@", "Sample Coder")).firstMatch
    XCTAssertTrue(coder.waitForExistence(timeout: 10), "OpenRouter's models that can use tools")
    XCTAssertTrue(coder.label.contains("$1.00 in, $2.00 out"), "with their prices")
    snap(app, "route-models")
    coder.tap()
    XCTAssertTrue(app.buttons.matching(identifier: "prefs.route.model").matching(NSPredicate(format: "label CONTAINS %@", "test/sample-coder")).firstMatch.waitForExistence(timeout: 10), "The chosen model")
    snap(app, "route-preferences")

    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    app.buttons["agents.new"].tap()
    let picker = app.buttons["newtask.provider"]
    XCTAssertTrue(picker.waitForExistence(timeout: 10))
    picker.tap()
    let route = app.buttons["OpenCode · OpenRouter"]
    XCTAssertTrue(route.waitForExistence(timeout: 5), "Offered by name, beside Claude Code and Codex")
    route.tap()
    let paid = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Paid per use through OpenRouter · test/sample-coder")).firstMatch
    XCTAssertTrue(paid.waitForExistence(timeout: 5), "It says it is paid, and with which model")
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    message.tap()
    message.typeText("Route hello")
    app.buttons["newtask.start"].tap()
    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Test agent reply")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 20), "The route's agent works")
    XCTAssertTrue(app.descendants(matching: .any)["task.paid"].exists, "The session is marked paid per use")
    XCTAssertTrue(barTitle(app, "OpenCode · OpenRouter").exists, "and named for its agent")
    snap(app, "route-session")

    // Switched off, it is not offered.
    more(app, "Preferences")
    let again = app.switches["prefs.route.enabled"]
    _ = again.waitForExistence(timeout: 10)
    for _ in 0..<6 where !(again.exists && again.isHittable) { app.swipeUp() }
    flip(again)
    XCTAssertTrue(app.buttons["prefs.route.model"].waitForNonExistence(timeout: 10))
    tab(app, "Agents")
    let back = app.buttons["agents.strip.all"]
    if back.waitForExistence(timeout: 5) { back.tap() }
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 10))
    app.buttons["agents.new"].tap()
    XCTAssertTrue(app.buttons["newtask.provider"].waitForExistence(timeout: 10))
    app.buttons["newtask.provider"].tap()
    XCTAssertTrue(app.buttons["Claude Code"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["OpenCode · OpenRouter"].exists, "Off means not offered")
  }

  /// A session the assistant starts is the same session in Agents, exactly once,
  /// and it works there.
  func testAssistantStartsASessionSeenOnceInAgents() throws {
    let app = try launch()
    ask(app, "Start Claude in my home folder")
    let open = app.buttons["assistant.openAgent"]
    XCTAssertTrue(open.waitForExistence(timeout: 15), "An agent session result")
    snap(app, "assistant-session")
    open.tap()
    XCTAssertTrue(barTitle(app, "Claude Code").waitForExistence(timeout: 10), "That session, in Agents")
    let chips = app.buttons.matching(identifier: "agents.strip.chip")
      .matching(NSPredicate(format: "label CONTAINS %@", "Claude Code in Home folder"))
    XCTAssertEqual(chips.count, 1, "Exactly one session")
    let composer = app.textViews["task.composer"].exists ? app.textViews["task.composer"] : app.textFields["task.composer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    composer.tap()
    composer.typeText("Say hello")
    app.buttons["task.send"].tap()
    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Test agent reply")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 20), "The session works")
    snap(app, "agents-from-assistant")
  }

  /// The session strip switches without mixing conversations, and renames.
  func testAgentsStripSwitchesAndRenames() throws {
    let app = try launch()
    tab(app, "Agents")
    func start(_ text: String) {
      let plus = app.buttons["agents.strip.new"]
      if plus.exists { plus.tap() } else { app.buttons["agents.new"].tap() }
      let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
      XCTAssertTrue(message.waitForExistence(timeout: 10))
      message.tap()
      message.typeText(text)
      app.buttons["newtask.start"].tap()
      let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "You said: \"\(text)\"")).firstMatch
      XCTAssertTrue(reply.waitForExistence(timeout: 20))
    }
    start("First session hello")
    start("Second session hello")
    let chip = { (title: String) in
      app.buttons.matching(identifier: "agents.strip.chip").matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    }
    chip("First session hello").tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "You said: \"First session hello\"")).firstMatch.waitForExistence(timeout: 5))
    let leftover = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "You said: \"Second session hello\"")).firstMatch
    if leftover.exists {
      let dump = XCTAttachment(string: leftover.debugDescription + "\n\n" + app.debugDescription)
      dump.name = "debug-hidden-session"
      dump.lifetime = .keepAlways
      add(dump)
    }
    XCTAssertFalse(leftover.exists, "Only the selected session shows")
    snap(app, "agents-strip")
    chip("Second session hello").tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "You said: \"Second session hello\"")).firstMatch.waitForExistence(timeout: 5))
    chip("First session hello").press(forDuration: 1.0)
    let rename = app.buttons["Rename"]
    XCTAssertTrue(rename.waitForExistence(timeout: 5))
    rename.tap()
    let field = app.alerts.textFields.element(boundBy: 0)
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40))
    field.typeText("Website")
    app.buttons["Save"].tap()
    XCTAssertTrue(chip("Website").waitForExistence(timeout: 10), "Renamed")
    snap(app, "agents-renamed")
  }

  /// A folder name set in Preferences is understood by the assistant.
  func testPreferencesFolderNameReachesTheAssistant() throws {
    let app = try launch()
    more(app, "Preferences")
    let add = app.buttons["prefs.add.alias"]
    XCTAssertTrue(add.waitForExistence(timeout: 10))
    add.tap()
    // Text fields in an alert are found through the alert.
    let name = app.alerts.textFields.element(boundBy: 0)
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    name.typeText("normal work folder")
    let folder = app.alerts.textFields.element(boundBy: 1)
    folder.tap()
    folder.typeText("work")
    app.buttons["Save"].tap()
    XCTAssertTrue(app.staticTexts["normal work folder"].waitForExistence(timeout: 10), "Remembered")
    snap(app, "preferences")
    tab(app, "Assistant")
    ask(app, "Start Codex in my normal work folder")
    XCTAssertTrue(app.buttons["assistant.openAgent"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "~/work")).firstMatch.exists,
      "The session runs in the named folder")
    snap(app, "assistant-alias")
  }

  /// A remembered project → an agent session there → the project's live
  /// preview and a shell, from inside that session (the brief's second flow).
  func testRememberedProjectAgentPreviewAndShell() throws {
    let app = try launch()
    more(app, "Preferences")
    let add = app.buttons["prefs.add.workspace"]
    XCTAssertTrue(add.waitForExistence(timeout: 10))
    add.tap()
    let name = app.alerts.textFields.element(boundBy: 0)
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    name.typeText("Website")
    let folder = app.alerts.textFields.element(boundBy: 1)
    folder.tap()
    folder.typeText("work/apps/sample-site")
    app.buttons["Save"].tap()
    XCTAssertTrue(app.staticTexts["Website"].waitForExistence(timeout: 10), "Remembered")

    tab(app, "Assistant")
    ask(app, "Start Claude in my website")
    let open = app.buttons["assistant.openAgent"]
    XCTAssertTrue(open.waitForExistence(timeout: 15), "An agent session in the workspace")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "sample-site")).firstMatch.exists,
      "It runs in the remembered folder")
    open.tap()

    app.buttons["task.options"].tap()
    let preview = app.buttons["task.preview"]
    XCTAssertTrue(preview.waitForExistence(timeout: 5))
    preview.tap()
    let page = app.webViews.staticTexts["Hello from the sample site"]
    XCTAssertTrue(page.waitForExistence(timeout: 45), "The project's page renders on the phone")
    snap(app, "session-preview")
    app.buttons["Done"].tap()

    app.buttons["task.options"].tap()
    let shell = app.buttons["task.terminal"]
    XCTAssertTrue(shell.waitForExistence(timeout: 5))
    shell.tap()
    XCTAssertTrue(terminalElement(app).waitForExistence(timeout: 15), "A shell in the session's folder")
    snap(app, "session-terminal")
    app.buttons["task.terminal.close"].tap()
    XCTAssertTrue(app.buttons["task.options"].waitForExistence(timeout: 10), "Back in the session")
  }

  // MARK: Voice (speak to it, it does things, it speaks back)

  /// Spoken words become a request the Assistant acts on; Polish tidies them first.
  func testAssistantByVoice() throws {
    let app = try launch()
    let clear = app.buttons["assistant.clear"]
    if clear.waitForExistence(timeout: 5) { clear.tap() }
    let mic = app.buttons["assistant.mic"]
    XCTAssertTrue(mic.waitForExistence(timeout: 15), "An empty box offers the microphone")
    mic.tap()
    let done = app.buttons["voice.done"]
    XCTAssertTrue(done.waitForExistence(timeout: 10), "Listening")
    XCTAssertTrue(app.buttons["voice.polish"].exists)
    XCTAssertTrue(app.buttons["voice.cancel"].exists)
    snap(app, "voice-listening")
    done.tap()
    XCTAssertTrue(app.staticTexts["find my notes"].waitForExistence(timeout: 15), "The words, as said")
    XCTAssertTrue(app.descendants(matching: .any)["assistant.card.file"].waitForExistence(timeout: 15), "Acted on")
    XCTAssertTrue(app.buttons["voice.stopSpeaking"].waitForExistence(timeout: 5), "A spoken request is answered aloud")
    snap(app, "voice-assistant")

    XCTAssertTrue(mic.waitForExistence(timeout: 15))
    mic.tap()
    let polish = app.buttons["voice.polish"]
    XCTAssertTrue(polish.waitForExistence(timeout: 10))
    polish.tap()
    XCTAssertTrue(app.staticTexts["Find my notes."].waitForExistence(timeout: 15), "Polished before it is used")

    // Spoken replies can be switched off: talk without hearing it back.
    let speaker = app.buttons["assistant.speak"]
    XCTAssertEqual(speaker.value as? String, "On")
    speaker.tap()
    XCTAssertEqual(speaker.value as? String, "Off")
    XCTAssertTrue(mic.waitForExistence(timeout: 15))
    mic.tap()
    XCTAssertTrue(app.buttons["voice.done"].waitForExistence(timeout: 10))
    app.buttons["voice.done"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["assistant.card.file"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["voice.stopSpeaking"].waitForExistence(timeout: 3), "Nothing is read aloud")
    speaker.tap()
    XCTAssertEqual(speaker.value as? String, "On")

    // Cancel drops the recording.
    XCTAssertTrue(mic.waitForExistence(timeout: 15))
    mic.tap()
    XCTAssertTrue(app.buttons["voice.cancel"].waitForExistence(timeout: 10))
    app.buttons["voice.cancel"].tap()
    XCTAssertTrue(mic.waitForExistence(timeout: 5), "Back to the box")
  }

  /// Dictation goes where the keyboard would: an agent's message (to read
  /// before sending), the Mac's cursor from the Screen, a shell's prompt.
  /// Speak the task when starting an agent.
  func testSpeakingANewTask() throws {
    let app = try launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    app.buttons["agents.new"].tap()
    let mic = app.buttons["newtask.mic"]
    XCTAssertTrue(mic.waitForExistence(timeout: 10), "A microphone for the task")
    mic.tap()
    let done = app.buttons["voice.done"]
    XCTAssertTrue(done.waitForExistence(timeout: 10))
    done.tap()
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    let filled = expectation(for: NSPredicate(format: "value CONTAINS[c] %@", "find my notes"), evaluatedWith: message)
    wait(for: [filled], timeout: 15)
    snap(app, "newtask-voice")
  }

  func testDictationInAgentChatScreenAndTerminal() throws {
    let app = try launch()
    tab(app, "Agents")
    let plus = app.buttons["agents.strip.new"]
    XCTAssertTrue(plus.waitForExistence(timeout: 10) || app.buttons["agents.new"].waitForExistence(timeout: 5))
    if plus.exists { plus.tap() } else { app.buttons["agents.new"].tap() }
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    XCTAssertTrue(message.waitForExistence(timeout: 10))
    message.tap()
    message.typeText("Voice session hello")
    app.buttons["newtask.start"].tap()
    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "You said: \"Voice session hello\"")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 20))
    let taskMic = app.buttons["task.mic"]
    XCTAssertTrue(taskMic.waitForExistence(timeout: 10), "An empty message offers the microphone")
    taskMic.tap()
    let polish = app.buttons["voice.polish"]
    XCTAssertTrue(polish.waitForExistence(timeout: 10))
    polish.tap()
    let composer = app.textViews["task.composer"].exists ? app.textViews["task.composer"] : app.textFields["task.composer"]
    let filled = expectation(for: NSPredicate(format: "value == %@", "Find my notes."), evaluatedWith: composer)
    wait(for: [filled], timeout: 15)
    XCTAssertTrue(app.buttons["task.send"].exists, "Ready to read and send; nothing was sent")
    snap(app, "voice-agent-message")

    tab(app, "Screen")
    let desktop = app.buttons["screen.desktop"]
    XCTAssertTrue(desktop.waitForExistence(timeout: 10))
    desktop.tap()
    let screenMic = app.buttons["remote.mic"]
    XCTAssertTrue(screenMic.waitForExistence(timeout: 15))
    let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: screenMic)
    wait(for: [enabled], timeout: 20)
    screenMic.tap()
    let done = app.buttons["voice.done"]
    XCTAssertTrue(done.waitForExistence(timeout: 10))
    snap(app, "voice-screen")
    done.tap()
    XCTAssertTrue(app.staticTexts["Pasted on the Mac and copied"].waitForExistence(timeout: 15), "The words went to the Mac")
    XCTAssertTrue(waitForTyping { events in
      events.contains { $0["op"] as? String == "clipboardWrite" && (($0["text"] as? String) ?? "").lowercased().contains("find my notes") }
        && events.contains { $0["key"] as? String == "v" && ($0["modifiers"] as? [String]) == ["cmd"] }
    }, "On the Mac's clipboard, then pasted at the cursor")
    // The key bar has the microphone too.
    app.buttons["remote.keyboard"].tap()
    let keyMic = app.buttons["keybar.mic"]
    XCTAssertTrue(keyMic.waitForExistence(timeout: 10), "Speak instead of typing, from the key bar")
    keyMic.tap()
    XCTAssertTrue(app.buttons["voice.cancel"].waitForExistence(timeout: 10))
    app.buttons["voice.cancel"].tap()
    app.buttons["remote.back"].tap()

    more(app, "Terminal")
    let terminal = terminalElement(app)
    XCTAssertTrue(terminal.waitForExistence(timeout: 15))
    terminal.tap()
    let termMic = app.buttons["termbar.mic"]
    XCTAssertTrue(termMic.waitForExistence(timeout: 10), "The shell's key bar has the microphone")
    termMic.tap()
    let termDone = app.buttons["voice.done"]
    XCTAssertTrue(termDone.waitForExistence(timeout: 10))
    snap(app, "voice-terminal")
    termDone.tap()
    XCTAssertTrue(termDone.waitForNonExistence(timeout: 15), "The words went to the shell")
    // Dictation never presses Return: clear the words from the prompt so the
    // next test's shell starts clean.
    terminal.tap()
    let control = app.buttons["termbar.ctrl"]
    XCTAssertTrue(control.waitForExistence(timeout: 10))
    control.tap()
    app.typeText("c")
    app.buttons["termbar.hide"].tap()
  }

  // MARK: Every agent on the Mac ("no matter where the agent is from")

  /// Claude Code and Codex sessions Palm did not start show with their status
  /// and the agents they launched; one finishing raises an alert from any tab;
  /// the Assistant's "what needs me" includes them.
  func testEveryAgentOnTheMacAndItsAlerts() throws {
    try postToHost("/api/local/test/agents", ["action": "setup"])
    let app = try launch(alerts: true)
    tab(app, "Agents")
    let rows = app.buttons.matching(identifier: "agents.watch.row")
    let claude = rows.matching(NSPredicate(format: "label CONTAINS %@", "Refactor the checkout")).firstMatch
    // Earlier tests leave Palm sessions above this section: scroll down to it.
    var swipes = 0
    while !claude.waitForExistence(timeout: swipes == 0 ? 10 : 2) && swipes < 8 {
      app.swipeUp()
      swipes += 1
    }
    XCTAssertTrue(claude.exists, "A Claude desktop session Palm did not start")
    if !claude.isHittable { app.swipeUp() }
    XCTAssertTrue(claude.label.contains("Working"), "With its status: \(claude.label)")
    XCTAssertTrue(rows.matching(NSPredicate(format: "label CONTAINS %@", "Build the pricing page")).firstMatch.waitForExistence(timeout: 5), "A Codex session")
    let terminalRow = rows.matching(NSPredicate(format: "label CONTAINS %@", "Summarise the logs")).firstMatch
    for _ in 0..<4 where !terminalRow.exists { app.swipeUp() }
    XCTAssertTrue(terminalRow.exists, "A Claude terminal session")
    for _ in 0..<4 where !claude.isHittable { app.swipeDown() }
    snap(app, "watch-list")

    claude.tap()
    let child = app.descendants(matching: .any)["watch.detail.child"]
    XCTAssertTrue(child.waitForExistence(timeout: 10), "The agent it launched")
    XCTAssertTrue(child.label.contains("Check the tests"))
    snap(app, "watch-detail")
    app.buttons["watch.open"].tap()
    XCTAssertTrue(app.staticTexts["Opened in Claude on the Mac."].waitForExistence(timeout: 10))
    app.buttons["Done"].tap()

    // It finishes while you are elsewhere in Palm.
    tab(app, "Files")
    try postToHost("/api/local/test/agents", ["action": "finish"])
    let banner = app.descendants(matching: .any)["watch.banner"]
    XCTAssertTrue(banner.waitForExistence(timeout: 20), "An alert when it finishes")
    XCTAssertTrue(app.staticTexts["Refactor the checkout finished"].exists)
    snap(app, "watch-alert")
    banner.tap()
    XCTAssertTrue(app.staticTexts["Checkout refactored; 42 tests pass."].waitForExistence(timeout: 10), "The alert opens that session")
    app.buttons["Done"].tap()

    tab(app, "Assistant")
    ask(app, "What needs my attention?")
    let show = app.buttons["assistant.showAgent"]
    XCTAssertTrue(show.waitForExistence(timeout: 15), "Agents Palm did not start are included")
    snap(app, "watch-assistant")
    show.tap()
    XCTAssertTrue(app.descendants(matching: .any)["watch.detail.header"].waitForExistence(timeout: 10))
  }

  /// Priority 5: timings are measured on the phone itself (Simulator numbers
  /// here only prove the measuring works; the real ones come from the iPhone).
  func testTimingsAreMeasuredOnThePhone() throws {
    let app = try launch()
    tab(app, "Screen")
    let desktop = app.buttons["screen.desktop"]
    XCTAssertTrue(desktop.waitForExistence(timeout: 10))
    desktop.tap()
    let keyboard = app.buttons["remote.keyboard"]
    XCTAssertTrue(keyboard.waitForExistence(timeout: 15))
    let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: keyboard)
    wait(for: [enabled], timeout: 20)
    keyboard.tap()
    XCTAssertTrue(app.buttons["keybar.hide"].waitForExistence(timeout: 10))
    app.typeText("a")
    sleep(1)
    app.buttons["keybar.hide"].tap()
    app.buttons["remote.back"].tap()
    more(app, "Timings")
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "timings.screenStart")).firstMatch.waitForExistence(timeout: 10),
      "Screen start was timed")
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "timings.inputAck")).firstMatch.exists,
      "The typed key was timed")
    snap(app, "timings")
  }

  // MARK: Several computers (priority 3), with two isolated test Macs

  /// Two computers, each with its own pairing and sessions: switching never
  /// moves a session, a request for the other computer is not run here, and
  /// forgetting one leaves the other working.
  func testTwoComputersStayApart() throws {
    guard let studio = ProcessInfo.processInfo.environment["PALM_UITEST_HOST2"], !studio.isEmpty else {
      throw XCTSkip("Needs the second test host from scripts/ios-ui-tests.mjs.")
    }
    let app = try launch()
    more(app, "Computers")
    let add = app.buttons["computers.add"]
    XCTAssertTrue(add.waitForExistence(timeout: 10))
    add.tap()
    let hostField = app.textFields["pair.host"]
    XCTAssertTrue(hostField.waitForExistence(timeout: 10))
    hostField.tap()
    hostField.typeText(studio)
    let codeField = app.textFields["pair.code"]
    codeField.tap()
    codeField.typeText(try pairCode(studio))
    app.buttons["pair.connect"].tap()
    let devices = app.buttons.matching(identifier: "computers.device")
    XCTAssertTrue(devices.matching(NSPredicate(format: "label CONTAINS %@", "Studio Mac")).firstMatch.waitForExistence(timeout: 20), "Studio Mac added")
    XCTAssertEqual(devices.count, 2, "Both computers stay paired")
    snap(app, "computers-two")

    // A session on the Studio Mac.
    tab(app, "Agents")
    XCTAssertTrue(app.staticTexts["Studio Mac"].waitForExistence(timeout: 10), "Agents works on the Studio Mac now")
    let plus = app.buttons["agents.strip.new"].exists ? app.buttons["agents.strip.new"] : app.buttons["agents.new"]
    XCTAssertTrue(plus.waitForExistence(timeout: 10))
    plus.tap()
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    XCTAssertTrue(message.waitForExistence(timeout: 10))
    message.tap()
    message.typeText("Studio job, go slow")
    app.buttons["newtask.start"].tap()
    XCTAssertTrue(app.buttons["task.stop"].waitForExistence(timeout: 15), "Working on the Studio Mac")

    // Back to the Sample Mac through the title menu.
    app.buttons["agents.strip.all"].tap()
    // With a title menu, iOS shows the title as a button.
    let title = app.navigationBars.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Agents")).firstMatch
    XCTAssertTrue(title.waitForExistence(timeout: 5), "The title opens the computers menu")
    title.tap()
    let sample = app.buttons["Sample Mac"]
    XCTAssertTrue(sample.waitForExistence(timeout: 5), "The title menu lists the computers")
    snap(app, "computers-title-menu")
    sample.tap()
    XCTAssertTrue(app.staticTexts["Sample Mac"].waitForExistence(timeout: 10))
    let elsewhere = app.buttons.matching(identifier: "agents.elsewhere.row").matching(NSPredicate(format: "label CONTAINS %@", "Studio job"))
    // Other computers' sessions come after this one's, which earlier tests filled.
    _ = elsewhere.firstMatch.waitForExistence(timeout: 5)
    for _ in 0..<8 where !elsewhere.firstMatch.exists { app.swipeUp() }
    XCTAssertTrue(elsewhere.firstMatch.waitForExistence(timeout: 10), "The Studio session is shown as on the other computer")
    XCTAssertFalse(app.buttons.matching(identifier: "agents.strip.chip").matching(NSPredicate(format: "label CONTAINS %@", "Studio job")).firstMatch.exists,
      "and is not among this computer's sessions")
    snap(app, "computers-elsewhere")

    // A request naming the other computer is not run here.
    tab(app, "Assistant")
    ask(app, "Check downloads on Studio Mac")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "That is for Studio Mac")).firstMatch.waitForExistence(timeout: 15))

    // Forget the Studio Mac: the Sample Mac stays.
    more(app, "Computers")
    let studioRow = devices.matching(NSPredicate(format: "label CONTAINS %@", "Studio Mac")).firstMatch
    XCTAssertTrue(studioRow.waitForExistence(timeout: 10))
    studioRow.swipeLeft()
    app.buttons["Forget"].firstMatch.tap()
    let confirm = app.sheets.buttons["Forget"].exists ? app.sheets.buttons["Forget"] : app.buttons.matching(NSPredicate(format: "label == %@", "Forget")).element(boundBy: 0)
    XCTAssertTrue(confirm.waitForExistence(timeout: 5))
    confirm.tap()
    XCTAssertTrue(studioRow.waitForNonExistence(timeout: 10), "Forgotten")
    XCTAssertEqual(devices.count, 1)
    snap(app, "computers-forgotten")
  }

  // MARK: Pairing and landscape

  func testPairingScreenIsPlain() throws {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["Pair with your Mac"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "A touch away")).firstMatch.exists)
    snap(app, "pairing")
  }

  func testLandscapeTabs() throws {
    let app = try launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    XCUIDevice.shared.orientation = .landscapeLeft
    sleep(2)
    snap(app, "landscape-agents")
    more(app, "Terminal")
    sleep(3)
    snap(app, "landscape-terminal")
    // A new shell opens with the keyboard up and the tabs stepped aside (a run
    // of this test alone has no shell yet).
    let hideKeys = app.buttons["termbar.hide"]
    if hideKeys.exists { hideKeys.tap() }
    more(app, "Mac")
    sleep(2)
    snap(app, "landscape-mac")
    XCUIDevice.shared.orientation = .portrait
  }

  /// Accessibility text sizes keep every tab usable (nothing clipped or cut).
  func testLargeTextKeepsScreensReadable() throws {
    let app = XCUIApplication()
    app.launchEnvironment["PALM_UITEST_HOST"] = host
    app.launchEnvironment["PALM_UITEST_CODE"] = try pairCode()
    app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"]
    app.launch()
    tab(app, "Agents")
    XCTAssertTrue(app.buttons["agents.new"].waitForExistence(timeout: 15))
    snap(app, "large-text-agents")
    more(app, "Mac")
    sleep(2)
    snap(app, "large-text-mac")
    tab(app, "Files")
    sleep(1)
    snap(app, "large-text-files")
    tab(app, "Screen")
    sleep(1)
    snap(app, "large-text-screen")
  }

  // MARK: Demo recordings (scripts/ios-ui-tests.mjs --demo)
  //
  // Not tests: paced walk-throughs of the real app against the test host in
  // demo mode (sample desktop picture, scripted agents doing realistic work),
  // recorded from the Simulator for Palm's product video. Skipped otherwise.

  private func demoOnly() throws {
    guard ProcessInfo.processInfo.environment["PALM_UITEST_DEMO"] == "1" else {
      throw XCTSkip("Demo recordings run through scripts/ios-ui-tests.mjs --demo.")
    }
  }

  private func demoTask(_ app: XCUIApplication, agent: String, _ text: String) {
    let plus = app.buttons["agents.strip.new"].exists ? app.buttons["agents.strip.new"] : app.buttons["agents.new"]
    XCTAssertTrue(plus.waitForExistence(timeout: 15))
    plus.tap()
    let picker = app.buttons["newtask.provider"]
    XCTAssertTrue(picker.waitForExistence(timeout: 10))
    picker.tap()
    let choice = app.buttons[agent]
    XCTAssertTrue(choice.waitForExistence(timeout: 5), agent)
    choice.tap()
    app.buttons["newtask.project"].tap()
    let project = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "acme-web")).firstMatch
    XCTAssertTrue(project.waitForExistence(timeout: 10), "The sample project")
    project.tap()
    let message = app.textViews["newtask.message"].exists ? app.textViews["newtask.message"] : app.textFields["newtask.message"]
    XCTAssertTrue(message.waitForExistence(timeout: 10))
    message.tap()
    message.typeText(text)
    app.buttons["newtask.start"].tap()
  }

  /// Sessions made through the host (as the Mac's own setup page would), so
  /// the walk-through does not wait on the new-task sheet.
  private func demoSession(_ provider: String, _ text: String) throws {
    try postToHost("/api/local/connect", [:])
    try postToHost("/api/tasks", [
      "provider": provider, "cwd": "~/Developer/acme-web", "text": text, "access": "workspace",
      "model": "default", "screenControl": true, "attachments": [String](),
    ])
  }

  func testDemo1AgentsAndApproval() throws {
    try demoOnly()
    try demoSession("codex", "Fix the flaky checkout test")
    try demoSession("claude", "Summarise yesterday's error logs")
    try demoSession("claude", "Add a dark mode switch to Settings, then run the tests")
    let app = try launch()
    tab(app, "Agents")
    let hero = app.buttons.matching(identifier: "agents.task").matching(NSPredicate(format: "label CONTAINS %@", "dark mode")).firstMatch
    XCTAssertTrue(hero.waitForExistence(timeout: 20), "The dark mode session")
    sleep(4)
    snap(app, "demo-agents")
    hero.tap()
    let allow = app.buttons["approval.allow"]
    XCTAssertTrue(allow.waitForExistence(timeout: 90), "The agent asks to run the tests")
    sleep(2)
    snap(app, "demo-approval-chat")
    // The Mac screen beside the chat, so the change is seen landing.
    app.buttons["task.screen"].tap()
    sleep(5)
    snap(app, "demo-approval")
    allow.tap()
    let done = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "42 tests pass")).firstMatch
    XCTAssertTrue(done.waitForExistence(timeout: 90))
    sleep(5)
    snap(app, "demo-done")
  }

  func testDemo2Screen() throws {
    try demoOnly()
    let app = try launch()
    tab(app, "Screen")
    let desktop = app.buttons["screen.desktop"]
    XCTAssertTrue(desktop.waitForExistence(timeout: 15))
    sleep(1)
    desktop.tap()
    let surface = app.descendants(matching: .any)["remote.surface"]
    XCTAssertTrue(surface.waitForExistence(timeout: 20))
    sleep(4)
    snap(app, "demo-screen")
    surface.pinch(withScale: 2.2, velocity: 1.2)
    sleep(3)
    snap(app, "demo-screen-zoom")
    surface.pinch(withScale: 0.45, velocity: -1.2)
    sleep(2)
    XCUIDevice.shared.orientation = .landscapeLeft
    sleep(4)
    snap(app, "demo-screen-landscape")
    XCUIDevice.shared.orientation = .portrait
    sleep(2)
  }

  func testDemo3EveryAgent() throws {
    try demoOnly()
    try postToHost("/api/local/test/agents", ["action": "setup"])
    let app = try launch()
    tab(app, "Agents")
    let rows = app.buttons.matching(identifier: "agents.watch.row")
    let claude = rows.matching(NSPredicate(format: "label CONTAINS %@", "Refactor the checkout")).firstMatch
    var swipes = 0
    while !claude.waitForExistence(timeout: swipes == 0 ? 10 : 2) && swipes < 8 {
      app.swipeUp()
      swipes += 1
    }
    sleep(3)
    snap(app, "demo-every-agent")
    claude.tap()
    sleep(4)
    snap(app, "demo-every-agent-detail")
  }

  func testDemo4Files() throws {
    try demoOnly()
    let app = try launch()
    tab(app, "Files")
    sleep(3)
    snap(app, "demo-files")
    let documents = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Documents")).firstMatch
    XCTAssertTrue(documents.waitForExistence(timeout: 10))
    documents.tap()
    let invoices = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Invoices")).firstMatch
    XCTAssertTrue(invoices.waitForExistence(timeout: 10))
    sleep(2)
    invoices.tap()
    let invoice = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Invoice 1042")).firstMatch
    XCTAssertTrue(invoice.waitForExistence(timeout: 10))
    sleep(2)
    snap(app, "demo-files-invoices")
  }

  func testDemo5Assistant() throws {
    try demoOnly()
    let app = try launch()
    tab(app, "Assistant")
    sleep(2)
    ask(app, "Send me my latest invoice")
    let save = app.buttons["assistant.save"].firstMatch
    XCTAssertTrue(save.waitForExistence(timeout: 20), "The file comes back")
    sleep(3)
    snap(app, "demo-assistant")
    save.tap()
    _ = app.staticTexts["On this iPhone, verified"].waitForExistence(timeout: 15)
    sleep(3)
    snap(app, "demo-assistant-saved")
  }

  func testDemo6Terminal() throws {
    try demoOnly()
    let app = try launch()
    more(app, "Terminal")
    let terminal = terminalElement(app)
    XCTAssertTrue(terminal.waitForExistence(timeout: 15))
    sleep(2)
    app.typeText("cd Developer/acme-web && ls\n")
    sleep(3)
    snap(app, "demo-terminal")
  }

  // MARK: Remote recordings (scripts/ios-ui-tests.mjs --remote <host>)
  //
  // Not tests: paced walk-throughs of the real app controlling a real Mac (a
  // clean macOS VM running Palm), recorded from the Simulator for Palm's
  // product film while the Mac records its own screen. Each beat is logged
  // with its time ("PALMFILM <epoch> <beat>") so the two recordings can be
  // lined up and the touches drawn in. Skipped otherwise.

  private func remoteOnly() throws {
    guard ProcessInfo.processInfo.environment["PALM_UITEST_REMOTE"] == "1" else {
      throw XCTSkip("Remote recordings run through scripts/ios-ui-tests.mjs --remote.")
    }
  }

  private func mark(_ beat: String) {
    print(String(format: "PALMFILM %.3f ", Date().timeIntervalSince1970) + beat)
  }

  private func pause(_ seconds: Double) {
    usleep(useconds_t(seconds * 1_000_000))
  }

  /// The live picture: exactly the Mac's screen, however it is zoomed.
  private func liveScreen(_ app: XCUIApplication) -> XCUIElement {
    app.images["Live Mac screen"]
  }

  /// Turns the phone. A headless Simulator turns only the "device", so the
  /// app is also asked to turn itself (UI test builds listen for this).
  private func turn(landscape: Bool) {
    mark(landscape ? "turn-landscape" : "turn-portrait")
    XCUIDevice.shared.orientation = landscape ? .landscapeLeft : .portrait
    let name = landscape ? "palm.uitest.turn.landscape" : "palm.uitest.turn.portrait"
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
  }

  /// A tap on the Mac, at a point on its screen (0...1 across and down).
  private func tapMac(_ app: XCUIApplication, _ x: CGFloat, _ y: CGFloat, _ beat: String) {
    let frame = liveScreen(app).frame
    let at = CGVector(dx: frame.minX + x * frame.width, dy: frame.minY + y * frame.height)
    mark("tap \(beat) \(Int(at.dx)) \(Int(at.dy))")
    app.coordinate(withNormalizedOffset: .zero).withOffset(at).tap()
  }

  private func tapControl(_ app: XCUIApplication, _ id: String) {
    let button = app.buttons[id]
    XCTAssertTrue(button.waitForExistence(timeout: 10), id)
    let frame = button.frame
    mark("tap \(id) \(Int(frame.midX)) \(Int(frame.midY))")
    button.tap()
  }

  /// Types the way a person does: a word at a time with short gaps.
  private func typeSlowly(_ app: XCUIApplication, _ text: String, gap: Double = 0.12) {
    mark("type \(text.replacingOccurrences(of: "\n", with: "⏎"))")
    var word = ""
    for letter in text {
      word.append(letter)
      if letter == " " || letter == "\n" {
        app.typeText(word)
        word = ""
        pause(gap)
      }
    }
    if !word.isEmpty { app.typeText(word) }
  }

  private func hideKeyboard(_ app: XCUIApplication) {
    let done = app.buttons["remote.done"]
    let toggle = app.buttons["remote.keyboard"]
    if done.exists { tapControl(app, "remote.done") } else if toggle.exists, toggle.label == "Hide keyboard" { tapControl(app, "remote.keyboard") }
  }

  /// Waits for the first frames of the Mac's screen.
  private func waitForPicture(_ app: XCUIApplication) {
    XCTAssertTrue(liveScreen(app).waitForExistence(timeout: 20), "The live Mac screen")
    XCTAssertTrue(app.buttons["remote.stop"].waitForExistence(timeout: 20))
    let live = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Live")).firstMatch
    XCTAssertTrue(live.waitForExistence(timeout: 40), "Frames from the Mac")
    pause(1.5)
  }

  /// The whole screen at once (the landscape view starts slightly zoomed).
  private func showAll(_ app: XCUIApplication) {
    let zoom = app.buttons["remote.zoom"]
    if zoom.waitForExistence(timeout: 5), zoom.label == "Show all" { tapControl(app, "remote.zoom") }
  }

  // The demo VM's screen (1440 × 900 points): Notes and the running
  // Calculator in the Dock, Notes' New Note button (Notes tiled to the left
  // half) and the keys of Calculator, which waits on the right.
  private let dockNotes = CGPoint(x: 795.0 / 1440, y: 857.0 / 900)
  private let dockCalculator = CGPoint(x: 1211.0 / 1440, y: 857.0 / 900)
  private let notesNewNote = CGPoint(x: 460.0 / 1440, y: 56.0 / 900)
  private let calculatorKeys: [Character: CGPoint] = [
    "1": CGPoint(x: 774, y: 564), "8": CGPoint(x: 828, y: 456), "6": CGPoint(x: 882, y: 510),
    "÷": CGPoint(x: 936, y: 402), "4": CGPoint(x: 774, y: 510), "=": CGPoint(x: 936, y: 618),
  ].mapValues { CGPoint(x: $0.x / 1440, y: $0.y / 900) }

  /// Checks the Simulator really turns the app sideways before a take.
  func testRemote0Rotation() throws {
    try remoteOnly()
    let app = try launch()
    turn(landscape: true)
    pause(2)
    let window = app.windows.firstMatch.frame
    mark("window \(Int(window.width))x\(Int(window.height))")
    snap(app, "rotation-check")
    turn(landscape: false)
    XCTAssertGreaterThan(window.width, window.height, "The app turned sideways")
  }

  func testRemote1WholeMac() throws {
    try remoteOnly()
    let app = try launch()
    mark("launched")
    turn(landscape: false)
    pause(1)
    tab(app, "Screen")
    XCTAssertTrue(app.buttons["screen.desktop"].waitForExistence(timeout: 15))
    mark("screen-list")
    pause(3)
    tapControl(app, "screen.desktop")
    waitForPicture(app)
    mark("live-portrait")
    pause(3.5)

    // Sideways: the whole Mac.
    turn(landscape: true)
    pause(2.5)
    showAll(app)
    pause(2.5)

    // Tap Notes in the Dock; it opens on the Mac.
    tapMac(app, dockNotes.x, dockNotes.y, "dock-notes")
    pause(4)
    tapMac(app, notesNewNote.x, notesNewNote.y, "new-note")
    pause(1.5)

    // Type on the Mac from the phone's keyboard.
    tapControl(app, "remote.keyboard")
    pause(1.5)
    typeSlowly(app, "Dinner on Friday\nTable for four at 8\nBring the good wine")
    pause(2.5)
    hideKeyboard(app)
    pause(2)
    showAll(app)
    pause(2)

    // Over to Calculator, and split the bill: 186 ÷ 4.
    tapMac(app, dockCalculator.x, dockCalculator.y, "dock-calculator")
    pause(2.5)
    for key in "186÷4=" {
      tapMac(app, calculatorKeys[key]!.x, calculatorKeys[key]!.y, "calc-\(key)")
      pause(0.75)
    }
    pause(2)

    // Pinch into the answer, then back out.
    mark("pinch-in")
    liveScreen(app).pinch(withScale: 2.4, velocity: 1.2)
    pause(3)
    mark("pinch-out")
    liveScreen(app).pinch(withScale: 0.4, velocity: -1.2)
    pause(2)
    showAll(app)
    pause(1.5)

    // Back upright.
    turn(landscape: false)
    pause(3.5)
    mark("done")
  }

  /// One app's window, reshaped to the phone.
  func testRemote2Window() throws {
    try remoteOnly()
    let app = try launch()
    tab(app, "Screen")
    let notes = app.buttons.matching(NSPredicate(format: "label == %@", "Open Notes on your Mac")).firstMatch
    XCTAssertTrue(notes.waitForExistence(timeout: 15), "Notes in the list of open apps")
    mark("screen-list")
    pause(3)
    mark("tap open-notes \(Int(notes.frame.midX)) \(Int(notes.frame.midY))")
    notes.tap()
    waitForPicture(app)
    mark("notes-window")
    pause(5)
    tapMac(app, 0.5, 0.35, "notes-body")
    pause(3)
    mark("done")
  }

  // MARK: Helpers

  private func launch(alerts: Bool = false) throws -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["PALM_UITEST_HOST"] = host
    if alerts { app.launchEnvironment["PALM_UITEST_ALERTS"] = "1" }
    revokeEarlierTestPhones()
    app.launchEnvironment["PALM_UITEST_CODE"] = try pairCode()
    app.launch()
    return app
  }

  /// Every launch pairs a new test iPhone (its pairing lives in memory). The
  /// earlier ones are revoked first, so a full run stays under the Mac's
  /// limit of 32 paired phones ("Too many paired devices" after 32 tests).
  private func revokeEarlierTestPhones() {
    func call(_ path: String, _ body: [String: Any]? = nil) -> Data? {
      var request = URLRequest(url: URL(string: host + path)!)
      request.setValue(host, forHTTPHeaderField: "Origin")
      if let body {
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
      }
      let done = DispatchSemaphore(value: 0)
      var result: Data?
      URLSession.shared.dataTask(with: request) { data, _, _ in
        result = data
        done.signal()
      }.resume()
      _ = done.wait(timeout: .now() + 10)
      return result
    }
    guard let data = call("/api/local/setup"),
      let setup = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let devices = setup["devices"] as? [[String: Any]] else { return }
    for device in devices where device["kind"] as? String == "native" {
      if let id = device["id"] as? String { _ = call("/api/local/revoke", ["id": id]) }
    }
  }

  /// The test Mac's last keys and text (the test host keeps them; the real Mac never does).
  private func waitForMediaValue(_ keys: [String], above minimum: Double) -> Bool {
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
      var request = URLRequest(url: URL(string: host + "/api/local/media-diagnostics")!)
      request.setValue(host, forHTTPHeaderField: "Origin")
      let done = DispatchSemaphore(value: 0)
      var value: Any?
      URLSession.shared.dataTask(with: request) { data, _, _ in
        if let data { value = try? JSONSerialization.jsonObject(with: data) }
        done.signal()
      }.resume()
      _ = done.wait(timeout: .now() + 3)
      for key in keys { value = (value as? [String: Any])?[key] }
      if let number = value as? Double, number > minimum { return true }
      Thread.sleep(forTimeInterval: 0.1)
    }
    return false
  }

  private func mediaValue(_ keys: [String]) -> Double? {
    var request = URLRequest(url: URL(string: host + "/api/local/media-diagnostics")!)
    request.setValue(host, forHTTPHeaderField: "Origin")
    let done = DispatchSemaphore(value: 0)
    var value: Any?
    URLSession.shared.dataTask(with: request) { data, _, _ in
      if let data { value = try? JSONSerialization.jsonObject(with: data) }
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 3)
    for key in keys { value = (value as? [String: Any])?[key] }
    return value as? Double
  }

  private func typingOnHost() -> [[String: Any]] {
    var request = URLRequest(url: URL(string: host + "/api/local/test/typing")!)
    request.setValue(host, forHTTPHeaderField: "Origin")
    let done = DispatchSemaphore(value: 0)
    var events: [[String: Any]] = []
    URLSession.shared.dataTask(with: request) { data, _, _ in
      if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        events = object["events"] as? [[String: Any]] ?? []
      }
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 10)
    return events
  }

  /// A menu item, tapped once the menu has finished opening (a tap during the
  /// opening animation is ignored); tapped again if the menu is still up.
  private func choose(_ app: XCUIApplication, _ title: String) {
    let item = app.buttons[title]
    XCTAssertTrue(item.waitForExistence(timeout: 5), "\(title) in the menu")
    // A tap while the menu is still opening is lost (a full run left the
    // Dock menu open for 15 s): tap until the menu closes, at most three times.
    let hittable = NSPredicate(format: "isHittable == true")
    for _ in 0..<3 {
      _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: hittable, object: item)], timeout: 3)
      guard item.exists else { return }
      item.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      if item.waitForNonExistence(timeout: 1.5) { return }
    }
  }

  private func lastScroll(_ events: [[String: Any]]) -> Double? {
    events.last { $0["op"] as? String == "scroll" && (($0["dy"] as? Double) ?? 0) != 0 }?["dy"] as? Double
  }

  private func typedText(_ events: [[String: Any]]) -> String {
    events.compactMap { $0["op"] as? String == "text" ? $0["text"] as? String : nil }.joined()
  }

  private func waitForTyping(timeout: TimeInterval = 10, _ matches: ([[String: Any]]) -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      if matches(typingOnHost()) { return true }
      Thread.sleep(forTimeInterval: 0.3)
    }
    return false
  }

  /// A request to the test host itself (never the real Mac).
  private func postToHost(_ path: String, _ body: [String: Any]) throws {
    var request = URLRequest(url: URL(string: host + path)!)
    request.httpMethod = "POST"
    request.setValue(host, forHTTPHeaderField: "Origin")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let done = DispatchSemaphore(value: 0)
    var status = 0
    URLSession.shared.dataTask(with: request) { _, response, _ in
      status = (response as? HTTPURLResponse)?.statusCode ?? 0
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 10)
    XCTAssertEqual(status, 200, "Test host \(path)")
  }

  private func pairCode(_ base: String? = nil) throws -> String {
    struct Code: Decodable { let code: String }
    let host = base ?? self.host!
    var request = URLRequest(url: URL(string: host + "/api/local/pair-code")!)
    request.httpMethod = "POST"
    request.setValue(host, forHTTPHeaderField: "Origin")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data("{}".utf8)
    let done = DispatchSemaphore(value: 0)
    var result: Result<String, Error> = .failure(URLError(.timedOut))
    URLSession.shared.dataTask(with: request) { data, _, error in
      if let data, let code = try? JSONDecoder().decode(Code.self, from: data) { result = .success(code.code) }
      else if let error { result = .failure(error) }
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 10)
    return try result.get()
  }

  /// Terminal, Mac and Preferences live under More.
  private func more(_ app: XCUIApplication, _ row: String) {
    tab(app, "More")
    let link = app.buttons["more.\(row.lowercased())"]
    // Tapping More again returns to its list.
    if !link.waitForExistence(timeout: 3) { tab(app, "More") }
    XCTAssertTrue(link.waitForExistence(timeout: 10), "\(row) in More")
    link.tap()
  }

  private func assistantInput(_ app: XCUIApplication) -> XCUIElement {
    app.textFields["assistant.input"].exists ? app.textFields["assistant.input"] : app.textViews["assistant.input"]
  }

  private func ask(_ app: XCUIApplication, _ text: String) {
    let input = assistantInput(app)
    XCTAssertTrue(input.waitForExistence(timeout: 15), "The assistant's input")
    input.tap()
    input.typeText(text)
    app.buttons["assistant.send"].tap()
  }

  private func tab(_ app: XCUIApplication, _ name: String) {
    let button = app.tabBars.buttons[name]
    XCTAssertTrue(button.waitForExistence(timeout: 10), "\(name) tab")
    button.tap()
  }

  private func terminalElement(_ app: XCUIApplication) -> XCUIElement {
    let identified = app.descendants(matching: .any)["terminal.view"]
    return identified
  }

  /// Flips a toggle by its switch, not the middle of its row.
  private func flip(_ toggle: XCUIElement) {
    let before = toggle.value as? String
    let knob = toggle.switches.firstMatch
    if knob.exists { knob.tap() } else { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap() }
    let changed = NSPredicate(format: "value != %@", before ?? "")
    _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: changed, object: toggle)], timeout: 5)
  }

  /// A screen's title in its bar. A title that opens the computers menu is a
  /// button to iOS; any other title is plain text.
  private func barTitle(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    app.navigationBars.descendants(matching: .any).matching(NSPredicate(
      format: "(elementType == %d OR elementType == %d) AND label == %@",
      XCUIElement.ElementType.staticText.rawValue, XCUIElement.ElementType.button.rawValue, title
    )).firstMatch
  }

  private func snap(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
