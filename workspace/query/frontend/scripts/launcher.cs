// 一级启动器（目标 2 步骤 2.6b，决策 D2-6 / D2-14 / D2-23）
// 编译（零下载，系统自带）：见 scripts/build-launcher.ps1
// 行为：找 query\bin\<产品名>.exe（新布局：query\ = 程序树、query\bin\ = Electron 运行时，D2-28/D2-29）
//       → 退回 bin\<产品名>.exe（旧布局）→ 都找不到就弹框**指名两条路径** → 找到就带参数拉起，然后**立刻退出**。
// 约束：C# 5 语法（csc v4.0.30319）；源码纯 ASCII 之外的字符串靠 UTF-8 BOM 保证 —— 见下方 note。
// NOTE: 本文件必须保存为 UTF-8 **带 BOM**，否则 csc 会按 ANSI 解读，弹框中文会乱码（施工单 §4.7 P22）。
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class Launcher
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    const uint MB_OK = 0x0;
    const uint MB_ICONERROR = 0x10;
    const uint MB_ICONINFORMATION = 0x40;

    static int Main(string[] args)
    {
        // 启动器自己的目录：workspace/ 或 portable/（两处结构完全一样，D2-31 乙）
        string here = AppDomain.CurrentDomain.BaseDirectory;

        // Electron 本体固定在 <根>\bin\ 下；后两条只兼容历史布局，正常用不到。
        string[] candidates = new string[] {
            Path.Combine(here, "bin", "船舶故障诊断系统.exe"),
            Path.Combine(here, "dist", "bin", "船舶故障诊断系统.exe"),
            Path.Combine(here, "query", "bin", "船舶故障诊断系统.exe")
        };
        string target = null;
        foreach (string c in candidates) { if (File.Exists(c)) { target = c; break; } }

        if (target == null)
        {
            MessageBoxW(IntPtr.Zero,
                "缺少程序本体（以下位置都没找到）：\n" + string.Join("\n", candidates) + "\n\n" +
                "本程序的目录结构必须是：\n" +
                "  船舶故障诊断系统.exe   （本启动器）\n" +
                "  bin\\                Electron 运行时与入口 exe\n" +
                "  query\\              程序本体（与源码区 workspace/query 同构）\n" +
                "  data\\              知识库与运行数据\n" +
                "  environment\\       运行时与模型\n\n" +
                "常见原因：解压不完整、被杀毒软件隔离，或单独移动过子目录。\n" +
                "请重新完整解压后再试。",
                "船舶故障诊断系统 — 启动失败", MB_OK | MB_ICONERROR);
            return 2;
        }

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = target;
            psi.WorkingDirectory = Path.GetDirectoryName(target);   // 明确工作目录：双击时 cwd 不稳定
            psi.UseShellExecute = false;
            // 把命令行参数原样透传（例如 --remote-debugging-port=9222）
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < args.Length; i++)
            {
                if (i > 0) sb.Append(' ');
                sb.Append(args[i]);
            }
            psi.Arguments = sb.ToString();
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBoxW(IntPtr.Zero,
                "拉起程序本体失败：\n" + target + "\n\n" + ex.Message,
                "船舶故障诊断系统 — 启动失败", MB_OK | MB_ICONERROR);
            return 4;
        }

        // ⚠️ 即起即退（D2-23）：不陪跑 —— 启动器崩了也不能影响本体，退出后不留进程。
        return 0;
    }
}
