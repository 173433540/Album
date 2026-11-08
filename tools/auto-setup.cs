using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Album · 自动检测安装")]
[assembly: System.Reflection.AssemblyDescription("自动识别 Windows 版本与 CPU 架构并启动对应安装包")]
[assembly: System.Reflection.AssemblyProduct("Album")]
[assembly: System.Reflection.AssemblyCompany("宇宙世界最强反派")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

static class AutoSetup
{
    [StructLayout(LayoutKind.Sequential)]
    struct OSVERSIONINFOEX
    {
        public int dwOSVersionInfoSize;
        public int dwMajorVersion;
        public int dwMinorVersion;
        public int dwBuildNumber;
        public int dwPlatformId;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szCSDVersion;
        public ushort wServicePackMajor;
        public ushort wServicePackMinor;
        public ushort wSuiteMask;
        public byte wProductType;
        public byte wReserved;
    }

    [DllImport("ntdll.dll")]
    static extern int RtlGetVersion(ref OSVERSIONINFOEX info);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    const ushort IMAGE_FILE_MACHINE_I386 = 0x014c;
    const ushort IMAGE_FILE_MACHINE_AMD64 = 0x8664;
    const ushort IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

    static string ArchName(ushort machine)
    {
        switch (machine)
        {
            case IMAGE_FILE_MACHINE_I386: return "x86";
            case IMAGE_FILE_MACHINE_AMD64: return "x64";
            case IMAGE_FILE_MACHINE_ARM64: return "ARM64";
            default: return "未知(0x" + machine.ToString("X") + ")";
        }
    }

    static ushort NativeMachine()
    {
        try
        {
            ushort processMachine;
            ushort nativeMachine;
            if (IsWow64Process2(IntPtr.Zero, out processMachine, out nativeMachine))
            {
                if (nativeMachine != 0) return nativeMachine;
            }
        }
        catch
        {
            // 老系统没有该 API，退回环境变量判断
        }

        string arch = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432");
        if (String.IsNullOrEmpty(arch)) arch = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE");
        if (String.Equals(arch, "ARM64", StringComparison.OrdinalIgnoreCase)) return IMAGE_FILE_MACHINE_ARM64;
        if (String.Equals(arch, "AMD64", StringComparison.OrdinalIgnoreCase)) return IMAGE_FILE_MACHINE_AMD64;
        return IMAGE_FILE_MACHINE_I386;
    }

    static string SetupName(ushort machine)
    {
        switch (machine)
        {
            case IMAGE_FILE_MACHINE_I386: return "Album_Windows_x86_Setup.exe";
            case IMAGE_FILE_MACHINE_AMD64: return "Album_Windows_x64_Setup.exe";
            case IMAGE_FILE_MACHINE_ARM64: return "Album_Windows_ARM64_Setup.exe";
            default: return null;
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        bool check = args.Length > 0 && String.Equals(args[0], "--check", StringComparison.OrdinalIgnoreCase);
        if (!check)
        {
            IntPtr console = GetConsoleWindow();
            if (console != IntPtr.Zero) ShowWindow(console, 0);
        }

        OSVERSIONINFOEX os = new OSVERSIONINFOEX();
        os.dwOSVersionInfoSize = Marshal.SizeOf(typeof(OSVERSIONINFOEX));
        RtlGetVersion(ref os);

        bool isWin11 = os.dwMajorVersion == 10 && os.dwBuildNumber >= 22000;
        string osName = os.dwMajorVersion == 10
            ? (isWin11 ? "Windows 11" : "Windows 10")
            : ("Windows " + os.dwMajorVersion + "." + os.dwMinorVersion);
        string osFull = osName + " (Build " + os.dwBuildNumber + ")";

        ushort machine = NativeMachine();
        string arch = ArchName(machine);
        string setup = SetupName(machine);
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string setupPath = setup == null ? null : Path.Combine(baseDir, setup);
        bool exists = setupPath != null && File.Exists(setupPath);

        if (check)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("os=" + osFull);
            Console.WriteLine("arch=" + arch);
            Console.WriteLine("setup=" + (setup ?? "(none)"));
            Console.WriteLine("path=" + (setupPath ?? "(none)"));
            Console.WriteLine("exists=" + exists);
            return exists ? 0 : 2;
        }

        if (os.dwMajorVersion < 10)
        {
            MessageBox.Show("本软件仅支持 Windows 10 与 Windows 11。\n\n当前系统：" + osFull,
                "系统版本不受支持", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        if (setup == null)
        {
            MessageBox.Show("无法识别当前 CPU 架构：" + arch + "\n请联系作者获取对应版本。",
                "架构不受支持", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        if (!exists)
        {
            MessageBox.Show("检测到当前系统为 " + osFull + "，" + arch + " 架构。\n\n"
                + "需要安装包：" + setup + "\n"
                + "请把三个安装包与这个自动检测程序放在同一个文件夹后重试。\n\n"
                + "当前目录：" + baseDir,
                "找不到匹配的安装包", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }

        DialogResult answer = MessageBox.Show(
            "检测到系统：" + osFull + "\nCPU 架构：" + arch + "\n\n"
            + "将启动：" + setup + "\n\n是否继续安装？",
            "Album · 自动选择安装包", MessageBoxButtons.YesNo, MessageBoxIcon.Information);

        if (answer != DialogResult.Yes) return 0;

        try
        {
            Process.Start(new ProcessStartInfo(setupPath) { UseShellExecute = true, WorkingDirectory = baseDir });
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动安装程序失败：" + ex.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 3;
        }
    }
}