; Included by the Windows installer (electron-builder.yml, nsis.include).
; Uninstalling removes the "Start at login" entry the app added for this user.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GRIDCITY"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "GRIDCITY"
!macroend
