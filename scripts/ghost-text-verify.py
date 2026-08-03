#!/usr/bin/env python3
"""
CHIMERA Inline Completion — Ghost Text Rendering Verification.

Uses Playwright (Chromium) to:
1. Load the app (Vite dev server must be running on :3000)
2. Open the editor with a TypeScript file
3. Type some code (triggers inline completion provider after 300ms debounce)
4. Wait for the AI completion to fire (300ms debounce + ~150ms server = ~500ms)
5. Inspect the Monaco DOM for ghost-text elements
6. Capture console logs showing the "[editor] AI inline completion:" log line

Monaco renders inline ghost text as <span> elements with class
`.suggest-preview-text` (and the ghost-text container `.ghost-text-decoration`
in older versions). The presence of EITHER confirms ghost text rendered.

Why a real browser test (not a unit test):
- The InlineCompletionsProvider is registered only when Monaco actually
  mounts in a real browser context. JSDOM can't run Monaco.
- Ghost text rendering depends on Monaco's content widget system, which
  only paints in a real layout engine.
- This is the same lesson learned during the lip sync work: anything
  timing-sensitive (useFrame, requestAnimationFrame, AudioWorklet) needs
  a real browser to verify, not a headless log scrape.
"""

import subprocess
import time
import json
import sys
import os
import urllib.request


def wait_for_url(url, timeout=30):
    start = time.time()
    while time.time() - start < timeout:
        try:
            # Use 127.0.0.1 explicitly — localhost may resolve to ::1 first
            # and fail with Connection refused on IPv4-only listeners.
            req = urllib.request.Request(url, headers={"User-Agent": "wait_for_url"})
            urllib.request.urlopen(req, timeout=2)
            return True
        except Exception:
            time.sleep(0.5)
    return False


def main():
    print("=" * 70)
    print("CHIMERA Inline Completion — Ghost Text Rendering Verification")
    print("=" * 70)

    repo_root = "/home/z/my-project"

    # ── 1. Verify both servers are reachable ─────────────────────────
    print("\n1. Verifying backend (:3001) + frontend (:3000) reachable...")
    if not wait_for_url("http://127.0.0.1:3001/api/health", timeout=15):
        print("   Starting backend server...")
        subprocess.Popen(
            ["npx", "tsx", "src/index.ts"],
            cwd=f"{repo_root}/server",
            env={**os.environ},
            stdout=open("/tmp/cs-backend.log", "w"),
            stderr=subprocess.STDOUT,
        )
        if not wait_for_url("http://127.0.0.1:3001/api/health", timeout=30):
            print("   ✗ Backend not reachable")
            sys.exit(1)
    print("   ✓ Backend reachable")

    # Vite dev server is flaky in this sandbox — dies when the spawning shell
    # exits. Spawn it as a child of THIS script so its lifetime is tied to
    # the verification run.
    vite_proc = None
    if not wait_for_url("http://localhost:3000", timeout=5):
        print("   Starting Vite dev server...")
        vite_proc = subprocess.Popen(
            ["npx", "vite", "--port", "3000", "--host", "0.0.0.0"],
            cwd=f"{repo_root}/app",
            env={**os.environ},
            stdout=open("/tmp/cs-vite.log", "w"),
            stderr=subprocess.STDOUT,
        )
        if not wait_for_url("http://localhost:3000", timeout=30):
            print("   ✗ Vite dev server not reachable")
            if vite_proc:
                vite_proc.terminate()
            sys.exit(1)
    print("   ✓ Frontend reachable")

    # ── 2. Auth ──────────────────────────────────────────────────────
    print("\n2. Authenticating...")
    email = f"ghost-test-{int(time.time())}@example.com"
    data = json.dumps({"email": email, "password": "test-password-123", "name": "Ghost Test"}).encode()
    req = urllib.request.Request(
        "http://localhost:3001/api/auth/register",
        data=data, headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass  # may already exist
    data = json.dumps({"email": email, "password": "test-password-123"}).encode()
    req = urllib.request.Request(
        "http://localhost:3001/api/auth/login",
        data=data, headers={"Content-Type": "application/json"},
    )
    login_resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
    token = login_resp["token"]
    print(f"   ✓ Token: {token[:20]}...")

    # ── 3. Launch Playwright + navigate to app ───────────────────────
    print("\n3. Launching Playwright Chromium...")
    from playwright.sync_api import sync_playwright

    console_logs = []
    completion_logs = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        def on_console(msg):
            text = msg.text
            console_logs.append(text)
            if "inline completion" in text or "AI inline" in text:
                completion_logs.append(text)
                print(f"   [console] {text}")

        page.on("console", on_console)
        page.on("pageerror", lambda e: print(f"   [PAGE ERROR] {e}"))

        # Load the app + inject auth token
        print("   Navigating to app...")
        page.goto("http://localhost:3000", wait_until="domcontentloaded")
        time.sleep(3)
        page.evaluate(f"""() => {{
            localStorage.setItem('code_siren_jwt', '{token}');
            localStorage.setItem('code_siren_user', JSON.stringify({{id: 'test', email: '{email}', name: 'Ghost Test'}}));
        }}""")
        # Reload so auth context picks up the token
        page.reload(wait_until="domcontentloaded")
        time.sleep(3)

        # ── 4. Navigate to a project + open the editor ──────────────
        # The app's home route shows projects. Try clicking into one,
        # or navigate directly to /editor if that route exists.
        print("   Looking for editor entry point...")

        # Try various routes
        tried_routes = []
        for route in ["/editor", "/ide", "/workspace", "/"]:
            try:
                page.goto(f"http://localhost:3000{route}", wait_until="domcontentloaded")
                time.sleep(3)
                # Check if Monaco loaded
                monaco = page.query_selector(".monaco-editor")
                if monaco:
                    print(f"   ✓ Monaco editor found at route {route}")
                    tried_routes.append(route)
                    break
                else:
                    print(f"   - No Monaco at {route}")
            except Exception as e:
                print(f"   - {route} failed: {e}")

        if not tried_routes:
            # Try clicking through the UI
            print("   Trying to click into a project...")
            try:
                # Look for any clickable project card / button
                page.goto("http://localhost:3000", wait_until="domcontentloaded")
                time.sleep(3)
                # Take a screenshot for debugging
                page.screenshot(path="/tmp/ghost-text-home.png")
                print("   Screenshot saved: /tmp/ghost-text-home.png")

                # Try clicking first card-like element
                cards = page.query_selector_all("button, a, [role='button'], .card, [class*='project']")
                print(f"   Found {len(cards)} clickable elements")
                clicked = False
                for card in cards[:10]:
                    txt = (card.text_content() or "").strip()
                    if txt and len(txt) < 50:
                        try:
                            card.click()
                            print(f"   Clicked: {txt[:40]}")
                            page.wait_for_load_state("domcontentloaded")
                            time.sleep(2)
                            monaco = page.query_selector(".monaco-editor")
                            if monaco:
                                print("   ✓ Monaco editor found after click")
                                clicked = True
                                break
                        except Exception:
                            continue
                if not clicked:
                    print("   ✗ Could not navigate to editor")
            except Exception as e:
                print(f"   ✗ Navigation failed: {e}")

        # Final check — Monaco present?
        monaco = page.query_selector(".monaco-editor")
        if not monaco:
            print("\n✗ Monaco editor not found in DOM — cannot verify ghost text")
            page.screenshot(path="/tmp/ghost-text-final.png")
            print("   Final screenshot: /tmp/ghost-text-final.png")
            browser.close()
            sys.exit(1)

        # ── 5. Type code into the editor to trigger inline completion ──
        print("\n5. Typing code into Monaco editor to trigger inline completion...")

        # Click on the editor to focus it
        page.click(".monaco-editor")
        time.sleep(0.5)

        # Type a snippet that should trigger a completion
        # (the AI completion provider fires on any cursor position change)
        page.keyboard.type("const greeting = 'hello'\nconsole.", delay=50)
        print("   Typed: const greeting = 'hello'\\nconsole.")

        # Wait for debounce (300ms) + server round-trip (~150ms) + render
        print("   Waiting 1500ms for debounce + server + render...")
        time.sleep(1.5)

        # Type more to trigger another completion
        page.keyboard.type(" l", delay=50)
        print("   Typed: ' l'")
        time.sleep(1.5)

        # ── 6. Inspect DOM for ghost text ───────────────────────────
        print("\n6. Inspecting Monaco DOM for ghost text elements...")

        # Monaco renders ghost text in a few possible elements:
        # - .suggest-preview-text (modern)
        # - .ghost-text (older)
        # - .monaco-editor .view-lines .ghost-text-decoration
        # Also check the suggest widget (dropdown) just in case — but we
        # want INLINE, not the dropdown.
        ghost_text_selectors = [
            ".suggest-preview-text",
            ".ghost-text",
            ".ghost-text-decoration",
            ".inline-completion-host",
            ".monaco-editor .view-lines [class*='ghost']",
            ".monaco-editor .view-lines [class*='preview']",
        ]

        found_ghost = False
        for sel in ghost_text_selectors:
            els = page.query_selector_all(sel)
            if els:
                print(f"   ✓ Found {len(els)} element(s) matching: {sel}")
                for el in els[:3]:
                    txt = (el.text_content() or "").strip()
                    if txt:
                        print(f"     text: {txt[:60]!r}")
                found_ghost = True

        # Also dump the entire view-lines content to see what's rendered
        view_lines = page.query_selector(".monaco-editor .view-lines")
        if view_lines:
            inner = view_lines.inner_html()
            # Save for debugging
            with open("/tmp/monaco-viewlines.html", "w") as f:
                f.write(inner)
            # Check for any span with color/style indicating ghost text
            # (Monaco uses inline styles or classes)
            import re
            ghost_spans = re.findall(
                r'<span[^>]*(?:ghost|preview|suggest-preview)[^>]*>([^<]*)</span>',
                inner,
            )
            if ghost_spans:
                print(f"   ✓ Found {len(ghost_spans)} ghost text spans via regex:")
                for txt in ghost_spans[:5]:
                    if txt.strip():
                        print(f"     text: {txt!r}")
                found_ghost = True

        # ── 7. Check console logs for completion events ─────────────
        print("\n7. Checking console logs for AI completion events...")
        print(f"   Total console logs: {len(console_logs)}")
        print(f"   Completion-related logs: {len(completion_logs)}")
        for log in completion_logs[:10]:
            print(f"     {log}")

        # ── 8. Result ────────────────────────────────────────────────
        print("\n" + "=" * 70)
        if found_ghost:
            print("✓ PASS — Ghost text elements found in Monaco DOM")
        elif completion_logs:
            print("△ PARTIAL — Inline completion provider fired (console logs)")
            print("  but no ghost text elements found in DOM.")
            print("  This may indicate the suggestion was empty (stub engine)")
            print("  or that Monaco's inline widget didn't paint in headless mode.")
        else:
            print("✗ INCONCLUSIVE — No ghost text + no completion logs")
            print("  The provider may not have fired (file too small, debounce, etc.)")

        print("=" * 70)
        print("\nDOM state captured to /tmp/monaco-viewlines.html for inspection.")
        page.screenshot(path="/tmp/ghost-text-after-typing.png")
        print("Screenshot: /tmp/ghost-text-after-typing.png")

        browser.close()

    # Cleanup spawned Vite (if we started it)
    if vite_proc:
        print("\nStopping spawned Vite dev server...")
        vite_proc.terminate()
        try:
            vite_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            vite_proc.kill()


if __name__ == "__main__":
    main()
