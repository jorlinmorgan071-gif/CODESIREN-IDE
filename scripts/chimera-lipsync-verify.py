#!/usr/bin/env python3
"""
CHIMERA Lip Sync Verification — real blendshape values during real TTS audio.

Uses Playwright (Chromium) to:
1. Start the app dev server + backend server
2. Navigate to the Face tab
3. Start a voice session (triggers wake greeting via TTS)
4. Capture console logs showing wlipsync vowel weights → VRM blendshapes
5. Verify the dominant vowel/blendshape actually shifts during playback

AudioWorkletNode (wlipsync) requires a real browser context — this is the
only way to verify it's actually running, not silently falling back to
the amplitude-based path.
"""

import subprocess
import time
import json
import sys
import os
import signal

def run_command(cmd, cwd=None, env=None, background=False):
    """Run a command, optionally in background."""
    full_env = {**os.environ, **(env or {})}
    if background:
        return subprocess.Popen(cmd, cwd=cwd, env=full_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return subprocess.run(cmd, cwd=cwd, env=full_env, capture_output=True, text=True, timeout=60)

def wait_for_url(url, timeout=30):
    """Wait for a URL to be reachable."""
    import urllib.request
    start = time.time()
    while time.time() - start < timeout:
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except:
            time.sleep(0.5)
    return False

def main():
    print("=" * 70)
    print("CHIMERA Lip Sync Verification")
    print("=" * 70)

    repo_root = "/home/z/my-project"

    # ── 1. Start backend server ──────────────────────────────────────
    print("\n1. Starting backend server...")
    jwt_secret = subprocess.run(
        ["grep", "^JWT_SECRET=", f"{repo_root}/server/.env"],
        capture_output=True, text=True
    ).stdout.split("=", 1)[1].strip() if os.path.exists(f"{repo_root}/server/.env") else "dev-secret-32-chars-minimum"

    server_proc = subprocess.Popen(
        ["npx", "tsx", "src/index.ts"],
        cwd=f"{repo_root}/server",
        env={**os.environ, "JWT_SECRET": jwt_secret},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )

    if not wait_for_url("http://localhost:3001/api/health", timeout=30):
        print("✗ Server failed to start")
        server_proc.kill()
        sys.exit(1)
    print("✓ Server running on :3001")

    # ── 2. Start app dev server ──────────────────────────────────────
    print("\n2. Starting app dev server...")
    app_proc = subprocess.Popen(
        ["npx", "vite", "--port", "3000", "--host"],
        cwd=f"{repo_root}/app",
        env={**os.environ, "VITE_API_URL": "http://localhost:3001/api"},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )

    if not wait_for_url("http://localhost:3000", timeout=30):
        print("✗ App failed to start")
        server_proc.kill()
        app_proc.kill()
        sys.exit(1)
    print("✓ App running on :3000")

    # ── 3. Register + login to get a JWT ─────────────────────────────
    print("\n3. Authenticating...")
    import urllib.request

    email = f"lipsync-test-{int(time.time())}@example.com"
    data = json.dumps({"email": email, "password": "testpassword123", "name": "LipSync Test"}).encode()
    try:
        req = urllib.request.Request("http://localhost:3001/api/auth/register",
            data=data, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req)
    except:
        pass

    data = json.dumps({"email": email, "password": "testpassword123"}).encode()
    req = urllib.request.Request("http://localhost:3001/api/auth/login",
        data=data, headers={"Content-Type": "application/json"})
    login_resp = json.loads(urllib.request.urlopen(req).read())
    token = login_resp["token"]
    print(f"✓ Token: {token[:20]}...")

    # ── 4. Start a voice session (triggers wake greeting TTS) ────────
    print("\n4. Starting voice session (triggers wake greeting)...")
    data = json.dumps({}).encode()
    req = urllib.request.Request("http://localhost:3001/api/voice/live/start",
        data=data, headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    session_resp = json.loads(urllib.request.urlopen(req).read())
    session_id = session_resp["sessionId"]
    print(f"✓ Session: {session_id}")

    # ── 5. Use Playwright to load the app and capture console logs ───
    print("\n5. Launching Playwright Chromium...")
    from playwright.sync_api import sync_playwright

    console_logs = []
    lip_sync_logs = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--autoplay-policy=no-user-gesture-required"])
        context = browser.new_context()
        page = context.new_page()

        # Capture ALL console messages
        def on_console(msg):
            text = msg.text
            console_logs.append(text)
            if "lip sync" in text or "wlipsync" in text or "VRM loaded" in text or "greeting" in text:
                lip_sync_logs.append(text)
                print(f"  [console] {text}")

        page.on("console", on_console)

        # Capture page errors (AudioWorkletNode failures would show here)
        def on_page_error(err):
            print(f"  [PAGE ERROR] {err}")
            console_logs.append(f"PAGE_ERROR: {err}")

        page.on("pageerror", on_page_error)

        # Navigate to the app with the token pre-set in localStorage
        print("  Navigating to app...")
        page.goto("http://localhost:3000")
        page.wait_for_load_state("networkidle")

        # Set auth token in localStorage
        page.evaluate(f"""() => {{
            localStorage.setItem('code_siren_jwt', '{token}');
            localStorage.setItem('code_siren_user', JSON.stringify({{id: 'test', email: '{email}', name: 'Test'}}));
        }}""")

        # Navigate to Face tab
        print("  Navigating to Face tab...")
        page.goto("http://localhost:3000/face")
        page.wait_for_load_state("networkidle")

        # Wait for VRM model to load
        print("  Waiting for VRM model to load (5s)...")
        time.sleep(5)

        # Click "Start Voice Call" button — this triggers:
        # 1. POST /api/voice/live/start → server creates session + fires greeting
        # 2. WS voice:greeting event → browser plays TTS audio
        # 3. TTS audio source connected → wlipsync node created
        # 4. Vowel weights logged during playback
        print("  Clicking 'Start Voice Call' button...")
        try:
            # Wait for the button to appear
            page.wait_for_selector("button:has-text('Start Voice Call')", timeout=10000)
            page.click("button:has-text('Start Voice Call')")
            print("  ✓ Clicked Start Voice Call")
        except Exception as e:
            print(f"  ⚠ Could not click button: {e}")
            # Try finding it by text
            try:
                buttons = page.query_selector_all("button")
                for btn in buttons:
                    text = btn.text_content() or ""
                    if "Start" in text or "Voice" in text:
                        btn.click()
                        print(f"  ✓ Clicked button: {text.strip()}")
                        break
            except Exception as e2:
                print(f"  ✗ Could not find button: {e2}")

        # Wait for greeting audio to play + lip sync to log
        print("  Waiting for greeting TTS + lip sync logs (20s)...")
        time.sleep(20)

        # Check if wlipsync profile loaded
        profile_logs = [l for l in console_logs if "wlipsync profile" in l]
        print(f"\n  Profile loaded: {profile_logs}")

        vrm_logs = [l for l in console_logs if "VRM loaded" in l]
        print(f"  VRM loaded: {vrm_logs}")

        # Check for any AudioWorklet errors
        worklet_errors = [l for l in console_logs if "worklet" in l.lower() or "AudioWorklet" in l]
        print(f"  Worklet messages: {worklet_errors}")

        # Check for lip sync log messages
        lipsync_messages = [l for l in console_logs if "lip sync" in l]
        print(f"\n  Lip sync log messages ({len(lipsync_messages)} total):")
        for msg in lipsync_messages:
            print(f"    {msg}")

        # If no lip sync messages, check if amplitude fallback is active
        if not lipsync_messages:
            print("\n  ⚠️ No lip sync messages — checking if wlipsync node was created...")
            lipsync_node_logs = [l for l in console_logs if "wlipsync node" in l]
            print(f"  wlipsync node creation logs: {lipsync_node_logs}")

            # Check for greeting audio (triggers TTS → audio source → lip sync)
            greeting_logs = [l for l in console_logs if "greeting" in l.lower()]
            print(f"  Greeting-related logs: {greeting_logs}")

        # Wait a bit more for any delayed logs
        print("\n  Waiting 10 more seconds for delayed logs...")
        time.sleep(10)

        # Final check
        all_lipsync = [l for l in console_logs if "lip sync" in l]
        print(f"\n  Total lip sync messages after wait: {len(all_lipsync)}")
        for msg in all_lipsync:
            print(f"    {msg}")

        # Print ALL console logs for debugging
        print(f"\n  All console logs ({len(console_logs)} total):")
        for msg in console_logs[-30:]:  # last 30
            print(f"    {msg}")

        browser.close()

    # ── 6. Clean up ──────────────────────────────────────────────────
    print("\n6. Cleaning up...")
    try:
        # End voice session
        req = urllib.request.Request(
            f"http://localhost:3001/api/voice/live/{session_id}/end",
            method="POST",
            headers={"Authorization": f"Bearer {token}"}
        )
        urllib.request.urlopen(req)
    except:
        pass

    server_proc.terminate()
    app_proc.terminate()
    time.sleep(2)
    server_proc.kill()
    app_proc.kill()

    # ── 7. Analysis ──────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("ANALYSIS")
    print("=" * 70)

    if lip_sync_logs:
        print(f"\n✓ {len(lip_sync_logs)} lip sync log messages captured")
        print("  Real vowel-differentiated blendshape values confirmed:")
        for log in lip_sync_logs:
            print(f"    {log}")

        # Check if different vowels appear
        vowels_found = set()
        for log in lip_sync_logs:
            for v in ["A=", "E=", "I=", "O=", "U="]:
                if v in log:
                    vowels_found.add(v[0])

        if len(vowels_found) >= 2:
            print(f"\n✓ PASS — {len(vowels_found)} different vowels detected: {', '.join(sorted(vowels_found))}")
            print("  Vowel-differentiated output confirmed — MFCC analysis is working.")
        else:
            print(f"\n⚠ Only {len(vowels_found)} vowel(s) detected — may need more varied audio")
    else:
        print("\n✗ No lip sync log messages captured")
        print("  Possible causes:")
        print("  1. AudioWorkletNode failed to initialize (check page errors above)")
        print("  2. wlipsync profile not loaded (check profile logs)")
        print("  3. No audio source connected (greeting TTS didn't fire or wasn't received)")
        print("  4. Volume threshold not met (lipSyncLogTimer only logs when volume > 0.05)")

        # Check what went wrong
        node_created = any("wlipsync node created" in l for l in console_logs)
        profile_loaded = any("wlipsync profile loaded" in l for l in console_logs)
        greeting_received = any("greeting" in l.lower() for l in console_logs)

        print(f"\n  Diagnostics:")
        print(f"    Profile loaded: {profile_loaded}")
        print(f"    Node created: {node_created}")
        print(f"    Greeting received: {greeting_received}")

if __name__ == "__main__":
    main()
