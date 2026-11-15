Unicode true
!include MUI2.nsh
Name "AI 额度窗（原生版）"
OutFile "${OUTPUT}\AI.Quota.Window.Native.Setup.0.2.0-native.1.exe"
InstallDir "$LOCALAPPDATA\Programs\AI Quota Window Native"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "${STAGE}\icon.ico"
!define MUI_UNICON "${STAGE}\icon.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!macro CheckRunning
 System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\AIQuotaNative") p.r0'
 ${If} $0 != 0
  System::Call 'kernel32::CloseHandle(p r0)'
  MessageBox MB_OK "请先在托盘退出 AI 额度窗，再继续安装或卸载。"
  Abort
 ${EndIf}
!macroend
Function .onInit
 !insertmacro CheckRunning
 SetRegView 64
 ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" "Release"
 ${If} $0 < 528040
  MessageBox MB_OK "需要 .NET Framework 4.8 或更新的4.x运行环境，请通过 Windows 更新安装后重试。"
  Abort
 ${EndIf}
FunctionEnd
Function un.onInit
 !insertmacro CheckRunning
FunctionEnd
Section
 SetOutPath "$INSTDIR"
 File "${STAGE}\AIQuotaWindow.exe"
 File "${STAGE}\AIQuotaWindow.exe.config"
 File "${STAGE}\icon.ico"
 File "${STAGE}\LICENSE"
 File "${STAGE}\README.md"
 File "${STAGE}\THIRD_PARTY_NOTICES.md"
 File "${STAGE}\SOURCE_INVENTORY.json"
 SetOutPath "$INSTDIR\licenses"
 File "${STAGE}\licenses\codex-quota-orb-LICENSE"
 File "${STAGE}\licenses\codex-usage-desktop-LICENSE"
 SetOutPath "$INSTDIR"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 CreateShortCut "$SMPROGRAMS\AI 额度窗（原生版）.lnk" "$INSTDIR\AIQuotaWindow.exe"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQuotaWindowNative" "DisplayName" "AI 额度窗（原生版）"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQuotaWindowNative" "DisplayVersion" "0.2.0-native.1"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQuotaWindowNative" "Publisher" "ZedekiahS"
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQuotaWindowNative" "UninstallString" '"$INSTDIR\Uninstall.exe"'
 WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQuotaWindowNative" "DisplayIcon" "$INSTDIR\AIQuotaWindow.exe"
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQuotaWindowNative" "NoModify" 1
 WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQuotaWindowNative" "NoRepair" 1
SectionEnd
Section Uninstall
 Delete "$SMPROGRAMS\AI 额度窗（原生版）.lnk"
 DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIQuotaWindowNative"
 Delete "$INSTDIR\AIQuotaWindow.exe"
 Delete "$INSTDIR\AIQuotaWindow.exe.config"
 Delete "$INSTDIR\icon.ico"
 Delete "$INSTDIR\LICENSE"
 Delete "$INSTDIR\README.md"
 Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
 Delete "$INSTDIR\SOURCE_INVENTORY.json"
 Delete "$INSTDIR\licenses\codex-quota-orb-LICENSE"
 Delete "$INSTDIR\licenses\codex-usage-desktop-LICENSE"
 RMDir "$INSTDIR\licenses"
 Delete "$INSTDIR\Uninstall.exe"
 RMDir "$INSTDIR"
 ; Never remove AppData, Codex or Monitor data.
SectionEnd
