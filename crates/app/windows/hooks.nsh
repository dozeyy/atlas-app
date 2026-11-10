; Extra steps for Atlas's NSIS installer (wired in tauri.conf.json: bundle.windows.nsis.installerHooks).

; Atlas Setup puts its own styled remover beside Atlas ("Uninstall Atlas.exe") and points Apps and
; features at it. A later install over the top (an update) writes the plain uninstaller's path back
; into that entry; point it at the styled remover again whenever the remover is there. The remover
; hands the installer's own switches (/UPDATE, /S, ...) straight to uninstall.exe, so updates and
; silent uninstalls still work.
;
; atlas-mcp.exe is started by Claude Code (the Atlas connector) and atlas-usage.exe by the /atlas
; skill, so either can be running while Atlas updates; the installer only closes atlas.exe. Windows
; will not overwrite or delete a running program, so the update stopped with "Error opening file for
; writing" (2026-11-09). It does let a running program be renamed: move a busy one aside (it keeps
; running from the new name until its chat ends) so the new copy can be written, and clear out the
; moved-aside copies from earlier updates once nothing runs them.
!macro AtlasFreeHelper NAME
  Delete "$INSTDIR\${NAME}.old*.exe"
  Delete "$INSTDIR\${NAME}.exe"
  ${If} ${FileExists} "$INSTDIR\${NAME}.exe"
    Push $0
    System::Call "kernel32::GetTickCount() i .r0"
    Rename "$INSTDIR\${NAME}.exe" "$INSTDIR\${NAME}.old-$0.exe"
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AtlasFreeHelper "atlas-mcp"
  !insertmacro AtlasFreeHelper "atlas-usage"
!macroend

; Atlas Setup runs this installer with /S /NS so no desktop shortcut appears, but Tauri's /NS also
; skips the Start menu entry, so Atlas never showed up in Windows search. Make sure the Start menu
; entry exists after every install and update (an update also repairs installs made without it).
; It is the same entry Tauri itself makes (same path, same AppUserModelID), so the uninstaller
; removes it as usual.
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\Uninstall Atlas.exe" 0 +2
    WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall Atlas.exe"'
  ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
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
    ; Helpers an update moved aside (see AtlasFreeHelper), when nothing runs them any more.
    Delete "$INSTDIR\atlas-mcp.old*.exe"
    Delete "$INSTDIR\atlas-usage.old*.exe"
  ${EndIf}
!macroend
