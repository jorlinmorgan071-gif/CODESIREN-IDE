@echo off
REM =====================================================================
REM  Code Siren — sync-to-github.bat
REM  One-command workflow: extract latest tarball -> sync to git repo
REM  -> commit -> push to GitHub.
REM
REM  SETUP (one-time):
REM    1. Extract the tarball ONCE: tar -xzf code-siren-6bugfix-AF.tar.gz
REM    2. cd into the extracted folder
REM    3. Initialize git (if not already done):
REM         git init
REM         git branch -M main
REM         git remote add origin git@github.com:YOUR-USERNAME/code-siren.git
REM    4. Set your identity (if not already done):
REM         git config user.name "Your Name"
REM         git config user.email "your_email@example.com"
REM
REM  USAGE (every time I give you a new tarball):
REM    1. Download the new tarball to the SAME folder as this .bat file
REM    2. Double-click sync.bat (or run it from cmd)
REM    3. It will: extract the new tarball over the existing files,
REM       stage all changes, commit with an auto-message, and push.
REM
REM  The script is idempotent — safe to run repeatedly.
REM =====================================================================

setlocal enabledelayedexpansion

REM --- Find the latest tarball in this folder ---
set "TARBALL="
for /f "delims=" %%F in ('dir /b /o-d *.tar.gz 2^>nul') do (
  set "TARBALL=%%F"
  goto :found
)
:found

if "%TARBALL%"=="" (
  echo [sync] ERROR: No .tar.gz file found in the current folder.
  echo [sync] Download the tarball first, then re-run this script.
  pause
  exit /b 1
)

echo [sync] Latest tarball: %TARBALL%

REM --- Extract the tarball (overwrites existing files) ---
echo [sync] Extracting...
tar -xzf "%TARBALL%" --overwrite
if errorlevel 1 (
  echo [sync] ERROR: Extraction failed.
  pause
  exit /b 1
)

REM --- Check git is initialized ---
if not exist .git (
  echo [sync] ERROR: .git folder not found. Run the SETUP steps in the header of this file first.
  pause
  exit /b 1
)

REM --- Stage all changes ---
echo [sync] Staging changes...
git add .

REM --- Check if there's anything to commit ---
git diff --cached --quiet --exit-code
if not errorlevel 1 (
  echo [sync] No changes to commit — already up to date.
  pause
  exit /b 0
)

REM --- Commit with timestamp ---
for /f "tokens=*" %%T in ('powershell -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"') do set "TIMESTAMP=%%T"
set "COMMIT_MSG=Update from tarball %TARBALL% (%TIMESTAMP%)"
echo [sync] Committing: %COMMIT_MSG%
git commit -m "%COMMIT_MSG%"

REM --- Push ---
echo [sync] Pushing to origin...
git push origin main
if errorlevel 1 (
  echo [sync] WARNING: Push failed. Check your SSH key, remote URL, and network.
  echo [sync] The commit is still local — fix the issue and run 'git push' manually.
  pause
  exit /b 1
)

echo.
echo [sync] SUCCESS — changes pushed to GitHub.
echo [sync] Commit: %COMMIT_MSG%
pause
