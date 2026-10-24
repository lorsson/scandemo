@echo off
rem Drag-and-drop front end for imagecore.exe.
rem Kept ASCII-only: cmd.exe reads .cmd files in the OEM code page, so UTF-8
rem text here would be garbled on a Chinese Windows install.
rem
rem   imagecore-drop.cmd INPUT [OUTPUT]   -> one file, explicit or auto output
rem   drag several files onto this file   -> each gets INPUT_<filter>.<ext>
rem   set IMAGECORE_FILTER=bw            -> choose original|gray|bw|enhance
setlocal EnableExtensions

set "EXE=%~dp0imagecore.exe"
if not exist "%EXE%" (
  echo [imagecore] imagecore.exe not found next to this script.
  goto :end
)

if "%~1"=="" (
  echo Usage:
  echo   - drag one or more image files onto this .cmd
  echo   - imagecore-drop.cmd INPUT [OUTPUT]
  echo Optional: set IMAGECORE_FILTER=bw  ^(original^|gray^|bw^|enhance^)
  goto :end
)

if not defined IMAGECORE_FILTER set "IMAGECORE_FILTER=enhance"

rem Second argument that already exists = a second input file (drag & drop),
rem otherwise it is the requested output path.
set "MODE=many"
if not "%~2"=="" if not exist "%~2" set "MODE=explicit"

set "RC=0"

if /i "%MODE%"=="explicit" (
  call :process "%~1" "%~2"
  if errorlevel 1 set "RC=%ERRORLEVEL%"
  goto :done
)

:many
if "%~1"=="" goto :done
call :process "%~1"
if errorlevel 1 set "RC=%ERRORLEVEL%"
shift
goto :many

:done
if "%RC%"=="0" (
  echo.
  echo Done.
) else (
  echo.
  echo Finished with errors ^(last exit code %RC%^).
)
goto :end

:process
rem Delayed expansion is needed to read N after set /a inside the same block.
rem (A '!' in a file name would be swallowed - acceptable for a drag-drop helper.)
setlocal EnableDelayedExpansion
set "IN=%~1"
set "OUT=%~2"

if not defined OUT (
  set "OUT=%~dpn1_%IMAGECORE_FILTER%%~x1"
  if exist "!OUT!" (
    set "BASE=%~dpn1_%IMAGECORE_FILTER%"
    set "EXT=%~x1"
    set /a N=1
    :find_free
    if exist "!BASE!-!N!!EXT!" (
      set /a N+=1
      goto :find_free
    )
    set "OUT=!BASE!-!N!!EXT!"
  )
)

echo [%IMAGECORE_FILTER%] "!IN!" -^> "!OUT!"
"%EXE%" -f "%IMAGECORE_FILTER%" "!IN!" "!OUT!"
set "R=%ERRORLEVEL%"
if not "!R!"=="0" echo [error] imagecore exit code !R!
endlocal & exit /b %R%

:end
if not defined IMAGECORE_NO_PAUSE pause
endlocal
exit /b 0
