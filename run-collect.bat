@echo off
rem ============================================================
rem  M Map - DSAT data collector wrapper (operator file: keep it ASCII + CRLF)
rem
rem  MAINTENANCE RULE (learned the hard way): an echo line containing a ')'
rem  inside an if/for parenthesised block CLOSES that block early, which
rem  silently turns the rest of the branch into unconditional code. A single
rem  "echo ... (%NODE_BIN%)" made every Node 22 machine report "version too
rem  old" and exit 1 - and it was invisible on a code read.
rem  => Any change here MUST be dry-run over all six branches (normal round /
rem     aborted round / no new meta / node too old / exit!=0 with output /
rem     exit!=0 without output), with both node calls stubbed out.
rem     Never ship a diff that was only read, not run.
rem  Keep it pure ASCII: the operator console may be GBK, so non-ASCII text
rem  here would render as mojibake.
rem ============================================================
cd /d "%~dp0"
title M Map - Data Collector

rem ---- U-03: single-instance lock (atomic mkdir; stale lock is WARN only) ----
rem  The collector names every part file by a second-precision stamp, so two
rem  instances started in the same second would write the SAME gzip files.
rem  A stale lock is never deleted automatically: operator decides.
set "LOCKDIR=data\tracking\.collect.lock"
if exist "%LOCKDIR%" (
  echo.
  echo [WARN] Lock folder already exists: %LOCKDIR%
  echo        Another collector may be running, or this is a stale lock.
  echo        Remove the folder manually if no collector is running.
  echo        This wrapper will NOT delete it automatically.
  echo.
  pause
  exit /b 5
)
mkdir "%LOCKDIR%" 2>nul
if errorlevel 1 (
  echo [ERROR] Cannot create lock folder. Aborting.
  pause
  exit /b 5
)

rem ---- Locate Node.js ----
set "NODE_BIN="
where node >nul 2>nul && set "NODE_BIN=node"
if not defined NODE_BIN if exist "C:\Program Files\nodejs\node.exe" set "NODE_BIN=C:\Program Files\nodejs\node.exe"

if not defined NODE_BIN (
  echo.
  echo [ERROR] Node.js not found. Please install it from https://nodejs.org/
  echo.
  if exist "%LOCKDIR%" rd /s /q "%LOCKDIR%"
  pause
  exit /b 1
)

rem ---- Node version gate (18 or newer) ----
rem  The collector uses global fetch(). On a Node older than 18 every request throws
rem  inside its own try/catch, so the run still ends with EXIT CODE 0 after the
rem  10-consecutive-failure breaker: a silent false success, not a visible error.
rem  So gate first and send nothing. Exit code 0 = usable, anything else = refuse.
"%NODE_BIN%" -e "process.exit(Number(process.versions.node.split(String.fromCharCode(46))[0]) >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js 18 or newer is required. This is what was found:
  "%NODE_BIN%" -v
  echo         [%NODE_BIN%]
  echo.
  echo         On older versions every request fails yet the run still ends with
  echo         exit code 0, so it looks successful while collecting nothing.
  echo         Install Node 18 or newer and run this file again.
  echo.
  if exist "%LOCKDIR%" rd /s /q "%LOCKDIR%"
  pause
  exit /b 1
)
echo [INFO] Node:
"%NODE_BIN%" -v
echo        [%NODE_BIN%]

rem ---- Args: double-click = 30 min; custom e.g. run-collect.bat --minutes=10 ----
set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--minutes=30"

rem ---- Newest metadata file BEFORE the run ----
rem  Afterwards this answers "did this run produce anything at all?" - without it a
rem  dead start cannot be told apart from a normal finish.
set "META_BEFORE="
for /f "delims=" %%F in ('dir /b /o-d "data\tracking\*-meta.json" 2^>nul') do if not defined META_BEFORE set "META_BEFORE=%%F"

cls
echo ============================================================
echo    M Map - DSAT Data Collector
echo ------------------------------------------------------------
echo    Args    : %ARGS%
echo    Output  : data\tracking\
echo.
echo    - Takes about 30 minutes. Do NOT close this window.
echo    - Progress, success rate and latency are shown live below.
echo    - Sample statistics for this round are derived at the end.
echo    - Press any key to exit when it is done.
echo ============================================================
echo.

"%NODE_BIN%" scripts\track-collect.mjs %ARGS%
set "RC=%errorlevel%"
rem ---- U-02/U-01: machine-readable outcome, written at :finish ----
set "FINAL_RC=0"
set "DERIVE_RAN=0"

rem ---- Did this run produce anything? ----
set "META_AFTER="
for /f "delims=" %%F in ('dir /b /o-d "data\tracking\*-meta.json" 2^>nul') do if not defined META_AFTER set "META_AFTER=%%F"
set "STAMP="
if defined META_AFTER set "STAMP=%META_AFTER:-meta.json=%"

echo.
if not defined META_AFTER goto :no_output
if "%META_AFTER%"=="%META_BEFORE%" goto :no_output

rem ---- Did it run the whole window? ----
rem  The collector returns 0 even when it aborts (hard breaker / stage-0 give-up),
rem  so the exit code alone cannot tell a full run from an early stop. Its meta.json
rem  carries   "aborted": null   on a normal run, or the reason string otherwise.
rem  ASCII match on purpose: the reason text is Chinese/UTF-8 and would be mojibake
rem  in a non-UTF-8 console, so we point at the file instead of echoing it.
set "ABORTED="
findstr /c:"aborted" "data\tracking\%META_AFTER%" 2>nul | findstr /c:"null" >nul 2>nul
if errorlevel 1 set "ABORTED=1"

if not "%RC%"=="0" goto :warn
if defined ABORTED goto :warn
echo [DONE] Collection finished the full window. Data saved to data\tracking\
goto :derive

:warn
set "FINAL_RC=2"
if not "%RC%"=="0" echo [WARN] Collector exit code = %RC% - network issue or stopped early.
if defined ABORTED (
  echo [WARN] The round STOPPED EARLY - it did not run the full window.
  rem  Split the two causes apart: an operator/system interrupt records "signal:...",
  rem  a collector self-abort records the breaker / stage-0 give-up. ASCII-only match
  rem  on purpose - the reason text itself is UTF-8 Chinese and would be mojibake here.
  findstr /c:"signal:" "data\tracking\%META_AFTER%" >nul 2>nul
  if errorlevel 1 (
    echo        Cause: collector aborted itself - failure breaker or stage-0 give-up.
  ) else (
    echo        Cause: interrupted by a signal - Ctrl+C, window closed, or shutdown.
  )
  echo        Full reason: the "aborted" line in data\tracking\%META_AFTER%
  echo        See also the tail of data\tracking\%STAMP%-run.log
) else (
  echo        See data\tracking\%STAMP%-run.log for details.
)
rem ---- U-01: an aborted or failed round MUST NOT produce an importable derived.json ----
echo [WARN] Derive skipped: this round is not usable. No derived.json written.
goto :finish

:derive
rem ---- Sample statistics for THIS round only ----
rem  track-derive filters by --label=<stamp>, so it reads only this round's parts,
rem  not the whole data/tracking history.
rem  U-04: use the SAME %NODE_BIN% as the collector. It is still a plain node call,
rem  NOT a shortcut around db-guard:
rem    * loadTruth returns early when --truth=none (the default), so the pg import
rem      line is never reached on this path and no DB connection can be opened.
rem    * npm run track:derive would route into scripts/db-guard.ts, which demands
rem      --allow-prod for any non-local DATABASE_URL. Adding that flag here would
rem      mean "I am writing to prod", which is false for this step.
rem  For the DB truth comparison, run it manually:
rem      npm run track:derive -- --label=<stamp> --truth=cloud --allow-prod
echo.
echo [INFO] Deriving sample statistics - local files only, no network, no database...
set "DERIVE_RAN=1"
call "%NODE_BIN%" scripts\track-derive.mjs --label=%STAMP%
if errorlevel 1 (
  set "FINAL_RC=4"
  echo [WARN] Derive step failed. Run it manually:
  echo        node scripts\track-derive.mjs --label=%STAMP%
) else (
  echo [INFO] Report: data\tracking\%STAMP%-derived-report.txt
)
goto :finish

:no_output
set "FINAL_RC=3"
echo [WARN] This run produced NO new data\tracking\*-meta.json.
echo        The collector did not start, or it died before writing its metadata.
echo        There is NO log for this run - do not read an older -run.log as if it
echo        described this one.
if not "%RC%"=="0" echo        Collector exit code = %RC%

:finish
rem ---- U-02/U-01: machine-readable status for downstream gates ----
set "STATUS_FILE=data\tracking\%STAMP%-collect-status.json"
if not defined STAMP set "STATUS_FILE=data\tracking\collect-status-nometa.json"
echo {"label":"%STAMP%","rc":%RC%,"finalRc":%FINAL_RC%,"deriveRan":%DERIVE_RAN%,"aborted":"%ABORTED%"}> "%STATUS_FILE%"
if exist "%LOCKDIR%" rd /s /q "%LOCKDIR%"
echo.
pause
exit /b %FINAL_RC%
