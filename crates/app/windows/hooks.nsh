; Extra steps for Atlas's NSIS installer (wired in tauri.conf.json: bundle.windows.nsis.installerHooks).

; Atlas Setup puts its own styled remover beside Atlas ("Uninstall Atlas.exe") and points Apps and
; features at it. A later install over the top (an update) writes the plain uninstaller's path back
; into that entry; point it at the styled remover again whenever the remover is there. The remover
; hands the installer's own switches (/UPDATE, /S, ...) straight to uninstall.exe, so updates and
; silent uninstalls still work.
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\Uninstall Atlas.exe" 0 +2
    WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall Atlas.exe"'
!macroend

; Tauri's uninstaller only clears HKCU\Software\<publisher>\<product> when "delete app data" is
; ticked, which a silent uninstall (/S) never ticks. The key holds the install folder, so it was
; left pointing at a folder that no longer exists. Remove it on every real uninstall (not on the
; uninstall that an update runs first: the new install writes it again right after).
; Only that key, and its parent only when nothing else is in it.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
  ${EndIf}
!macroend
