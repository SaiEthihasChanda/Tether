; Uninstall cleanup: the Explorer "Tether" submenu and the start-at-login entry the app adds.
; Synced files and Tether's state in %LOCALAPPDATA%\Tether are left in place.
!macro customUnInstall
  ; stop the background service (it runs from this app's files)
  nsExec::Exec 'taskkill /F /IM "Tether.exe"'
  DeleteRegKey HKCU "Software\Classes\*\shell\Tether"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Tether"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TetherApp"
!macroend
