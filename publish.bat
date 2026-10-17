@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM   Search Ad Killer - Publish to GitHub
REM
REM   Usage: double-click this file, or run publish.bat
REM
REM   Prerequisite (choose one):
REM     A. GitHub CLI installed and logged in  -> gh auth login
REM     B. GITHUB_TOKEN env var set            -> https://github.com/settings/tokens
REM
REM   NOTE: This script is intentionally ASCII-only.
REM   cmd.exe mangles non-ASCII text in .bat files unless the
REM   code page is switched, which breaks command parsing.
REM ============================================================

set REPO=zyp1690/search-ad-killer
set REMOTE=https://github.com/%REPO%.git

echo ============================================================
echo   Search Ad Killer - Publish
echo   Repo: %REPO%
echo ============================================================
echo.

REM --- 1. Check git ---
where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git not found. Install Git for Windows first.
  pause
  exit /b 1
)
echo [1/4] git OK

REM --- 2. Check auth ---
set AUTHED=
if defined GITHUB_TOKEN (
  set AUTHED=1
  echo [2/4] GITHUB_TOKEN found
) else (
  where gh >nul 2>&1
  if not errorlevel 1 (
    gh auth status >nul 2>&1
    if not errorlevel 1 (
      set AUTHED=1
      echo [2/4] GitHub CLI authenticated
    )
  )
)

if not defined AUTHED (
  echo [2/4] [ERROR] No GitHub authentication detected
  echo.
  echo     Pick one method, then run this file again:
  echo.
  echo     Method A - GitHub CLI
  echo       winget install --id GitHub.cli
  echo       gh auth login
  echo.
  echo     Method B - Personal Access Token
  echo       1. Open https://github.com/settings/tokens
  echo       2. Create token with repo scope
  echo       3. Run: set GITHUB_TOKEN=your_token_here
  echo.
  pause
  exit /b 1
)

REM --- 3. Configure remote ---
echo [3/4] Configuring remote...
git remote remove origin >nul 2>&1
git remote add origin %REMOTE%

REM --- 4. Push ---
echo [4/4] Pushing code and tags...
git push -u origin main
if errorlevel 1 (
  echo.
  echo [ERROR] Push failed. Check network and repo permissions.
  pause
  exit /b 1
)

git push --tags
if errorlevel 1 (
  echo [WARN] Tag push failed. Run manually: git push --tags
)

echo.
echo ============================================================
echo   Published
echo ============================================================
echo   Repo:    https://github.com/%REPO%
echo   Install: https://github.com/%REPO%/blob/main/INSTALL.md
echo   Issues:  https://github.com/%REPO%/issues
echo.
echo   Suggested next steps:
echo     - Fill in repo About (description + topics)
echo     - Create a Release and attach the CRX asset:
echo         gh release create v3.5.0 "dist/*.crx" "dist/*.zip" --title "v3.5.0"
echo ============================================================

pause
