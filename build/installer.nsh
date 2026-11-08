; 安装前架构校验：不匹配时明确提示并退出，不强制安装

!macro customInit
  !ifdef APP_ARM64
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_OK|MB_ICONSTOP "此安装包仅适用于 Windows 11 ARM64 设备。$\r$\n$\r$\n当前设备不是 ARM64 架构，请下载对应版本：$\r$\n· 64 位 Intel/AMD：Album_Windows_x64_Setup.exe$\r$\n· 32 位：Album_Windows_x86_Setup.exe" /SD IDOK
      RMDir "$INSTDIR"
      Quit
    ${EndIf}
  !endif

  !ifdef APP_32
    !ifndef APP_64
      ${If} ${RunningX64}
        MessageBox MB_YESNO|MB_ICONQUESTION "当前系统是 64 位 Windows，建议安装 64 位版本（Album_Windows_x64_Setup.exe），功能与性能更好。$\r$\n$\r$\n仍要继续安装 32 位版本吗？" /SD IDYES IDYES x86Continue
        RMDir "$INSTDIR"
        Quit
        x86Continue:
      ${EndIf}
    !endif
  !endif
!macroend